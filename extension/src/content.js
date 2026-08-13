/**
 * content.js
 * ---------------------------------------------------------------------------
 * Entrypoint. Loads last, so every other module is already on the namespace.
 *
 * ROUTING DECISION, in order:
 *   1. preRouter matches      -> answer locally from one API call (~50 ms)
 *   2. otherwise              -> stream through the gateway, servicing tool
 *                                calls from AbhiBusAPIRegistry as they arrive
 * ---------------------------------------------------------------------------
 */

(async () => {
  'use strict';

  const NS = window.__ABHI_AGENT__;
  if (!NS || NS.__booted) return;
  NS.__booted = true;

  /** @type {ReturnType<typeof NS.createChatUI>|null} */
  let ui = null;
  /** Set when the toolbar is clicked before the UI has finished mounting. */
  let toggleQueued = false;

  // Registered before the first `await`: the background worker reloads the tab
  // if sendMessage throws, so a listener that is even one tick late is a bug.
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== 'TOGGLE_PANEL') return false;
    if (ui) ui.toggle();
    else toggleQueued = true;
    sendResponse({ ok: true });
    return false;
  });

  await NS.loadSettings();

  /* =====================================================================
   * Conversation state
   * =================================================================== */

  const state = {
    sessionId: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
    /** Replayed to the backend so the model has context. */
    history: [],
    /** The last user message, for the "Try again" button. */
    lastPrompt: '',
    abort: null,
    /** Replayable render log — survives the in-tab results navigation. */
    transcript: [],
    /** Arguments of the most recent searchBuses call (for its `filter`). */
    lastSearchArgs: null,
    /** Queued "show these results on the page" action; fired after `done`. */
    pendingPage: null,
  };

  function remember(role, content) {
    if (!content?.trim()) return;
    state.history.push({ role, content });
    if (state.history.length > NS.CONFIG.maxHistoryTurns) {
      state.history = state.history.slice(-NS.CONFIG.maxHistoryTurns);
    }
  }

  /* =====================================================================
   * Persistence across the in-tab results navigation
   * =================================================================== */

  function persist() {
    NS.pageBridge.saveChat({
      sessionId: state.sessionId,
      history: state.history,
      lastPrompt: state.lastPrompt,
      transcript: state.transcript,
      open: ui?.isOpen ?? false,
      // Carried across navigations so the restored page behaves the same
      // even if the gateway is briefly unreachable during the reload.
      showBusListUi: NS.CONFIG.showBusListUi,
    });
  }

  /** Append a replayable entry and snapshot the whole conversation. */
  function record(entry) {
    state.transcript.push(entry);
    if (state.transcript.length > 30) state.transcript = state.transcript.slice(-30);
    persist();
  }

  // Catches the open/closed state at the moment the tab navigates away.
  window.addEventListener('pagehide', persist);

  function replayTranscript(entries) {
    for (const entry of entries || []) {
      try {
        if (entry.kind === 'user') {
          ui.addUserMessage(entry.text);
        } else if (entry.kind === 'assistant') {
          const bubble = ui.startAssistantMessage();
          bubble.set(entry.text);
          bubble.finish();
        } else if (entry.kind === 'buses') {
          // Env flag off: the list lives on the page, never in the chat —
          // including on replay of a transcript saved while it was on.
          if (NS.CONFIG.showBusListUi) ui.addBusResults(entry.data);
        } else if (entry.kind === 'seats') {
          ui.addSeatMap(entry.data);
        }
      } catch (err) {
        console.error('[abhi-agent] transcript replay failed', err);
      }
    }
  }

  /** Small hints that let the model skip a resolveCityIds round trip. */
  function pageContext() {
    const fromUrl = NS.AbhiBusAPIRegistry.cityIdsFromUrl();
    return {
      url: window.location.href,
      path: window.location.pathname,
      ...(fromUrl
        ? {
            journeyDate: fromUrl.dateToken,
          }
        : {}),
    };
  }

  /* =====================================================================
   * UI
   * =================================================================== */

  ui = NS.createChatUI({
    onSend: handleSend,
    onReset: handleReset,
    onLogin: openLogin,
    onSelectSeats: handleSelectSeats,
    onRetry: () => {
      if (state.lastPrompt) handleSend(state.lastPrompt, { replay: true });
    },
  }).mount();

  refreshSubtitle();

  /** Ordered stages of the AI search overlay (page-only results flow). */
  const SEARCH_STEPS = [
    'Understanding your request',
    'Scanning AbhiBus for your buses',
    'Opening live results',
    'Applying your preferences',
  ];

  // The gateway's UI flags (SHOW_BUS_LIST_UI in backend/.env). The value the
  // snapshot carried over bridges the moment right after a navigation, then
  // the live /api/ui-config answer wins.
  const restoredChat = NS.pageBridge.loadChat();
  if (typeof restoredChat?.showBusListUi === 'boolean') {
    NS.CONFIG.showBusListUi = restoredChat.showBusListUi;
  }
  await NS.loadUiConfig();

  // Restore a conversation interrupted by the extension's own in-tab
  // navigation to a results page, then run any queued page action
  // (auto-applying the user's asked-for sort/filters to the live list).
  if (restoredChat?.transcript?.length) {
    state.sessionId = restoredChat.sessionId || state.sessionId;
    state.history = Array.isArray(restoredChat.history) ? restoredChat.history : [];
    state.lastPrompt = restoredChat.lastPrompt || '';
    state.transcript = restoredChat.transcript;
    replayTranscript(state.transcript);
    if (restoredChat.open) ui.open();
  } else {
    showWelcome();
  }

  const queuedAction = NS.pageBridge.takePageAction();
  if (queuedAction && NS.pageBridge.isSameSearchPage(queuedAction.url)) {
    finishArrival(queuedAction);
  }

  // Honour a toolbar click that landed while we were still loading settings.
  if (toggleQueued) {
    toggleQueued = false;
    ui.toggle();
  }

  /**
   * Drive the live results page to match what the user asked for, narrating
   * progress with a ticket-stub chip in the conversation.
   * @returns {Promise<string[]>} labels of what was actually applied
   */
  async function applyIntentOnThisPage(intent) {
    const labels = NS.pageBridge.describeIntent(intent).join(' · ');
    const chip = ui.addToolChip(`Applying ${labels}`);
    const applied = await NS.pageBridge.applyFiltersOnPage(intent);
    if (applied.length) {
      chip.done(`Applied ${applied.join(' · ')}`);
    } else {
      chip.failed('Page filters not found — the card above is sorted by fare');
    }
    ui.flagAttention();
    return applied;
  }

  /**
   * Landing on the results page after the in-tab navigation. In the
   * page-only flow the AI overlay carries on from where it left off —
   * steps 1-3 done, "Applying your preferences" live — then signs off.
   */
  async function finishArrival(action) {
    const intent = action.intent;
    const work = NS.pageBridge.hasWork(intent);

    if (NS.CONFIG.showBusListUi) {
      if (work) applyIntentOnThisPage(intent);
      return;
    }

    const filterLabels = NS.pageBridge.describeIntent(intent).join(' · ');
    // resume: the loader was already showing before the navigation — carry
    // straight on mid-journey instead of replaying the whole entrance.
    ui.showSearchOverlay({
      route: action.route || '',
      date: action.date || '',
      steps: SEARCH_STEPS,
      doneThrough: 2,
      resume: true,
    });
    if (work) {
      ui.advanceSearchOverlay(2, `Applying ${filterLabels}`);
      const applied = await applyIntentOnThisPage(intent);
      ui.finishSearchOverlay(
        applied.length ? `Applied ${applied.join(' · ')}` : 'Your buses are ready!',
      );
    } else {
      ui.finishSearchOverlay('Your buses are ready!');
    }
  }

  /**
   * The page itself becomes the answer: after a successful bus search, load
   * the live results URL in THIS tab (the chat is persisted and restored on
   * the other side), or — when the tab already shows that search — just apply
   * the user's sort/filters to it directly.
   */
  async function maybeShowResultsOnPage() {
    const pending = state.pendingPage;
    state.pendingPage = null;
    // Any abhibus.com subdomain is fine — searchUrl is built on the origin
    // the user is already on so the sessionStorage snapshot survives.
    if (!pending?.url || !/^https:\/\/([a-z0-9-]+\.)*abhibus\.com\//i.test(pending.url)) {
      ui.hideSearchOverlay(); // never leave the loader stranded
      return;
    }

    if (NS.pageBridge.isSameSearchPage(pending.url)) {
      // Already on the results page: no navigation leg, finish in place.
      if (!NS.CONFIG.showBusListUi) {
        await finishArrival(pending);
        ui.close();
      } else if (NS.pageBridge.hasWork(pending.intent)) {
        await applyIntentOnThisPage(pending.intent);
      }
      return;
    }

    if (!NS.CONFIG.showBusListUi) {
      ui.advanceSearchOverlay(2); // "Opening live results…" while the page turns
      ui.close(); // persisted below as open:false
    }
    persist(); // the navigation reloads every content script
    NS.pageBridge.savePageAction(pending);
    ui.setStatus('Loading these results on the page…');
    // A beat so the user sees the answer land before the page swaps.
    setTimeout(() => window.location.assign(pending.url), 450);
  }

  function showWelcome() {
    const profile = NS.AbhiBusAPIRegistry.getSessionProfile();
    ui.showWelcome(profile?.firstName && !profile.expired ? profile.firstName : '');
  }

  function refreshSubtitle() {
    // The version stamp makes "did my extension reload take?" checkable at a
    // glance — stale content scripts have been a recurring debugging trap.
    const version = chrome.runtime.getManifest?.()?.version ?? '';
    const suffix = version ? ` · v${version}` : '';
    const profile = NS.AbhiBusAPIRegistry.getSessionProfile();
    if (profile?.firstName && !profile.expired) {
      ui.setSubtitle(`Signed in as ${profile.firstName}${suffix}`);
    } else if (NS.AbhiBusAPIRegistry.hasSession()) {
      ui.setSubtitle(`Signed in${suffix}`);
    } else {
      ui.setSubtitle(`Not signed in${suffix}`);
    }
  }

  function openLogin() {
    window.open(NS.CONFIG.loginUrl, '_blank', 'noopener');
  }

  /** "View seats" on a bus row: fetch the live seat chart and render it
   *  as a card in the conversation — no model round trip needed. */
  async function handleSelectSeats(req) {
    ui.setStatus(`Loading seats for ${req.operator || 'this bus'}…`);
    const outcome = await NS.AbhiBusAPIRegistry.execute('getSeatLayout', {
      sourceId: String(req.sourceId ?? ''),
      destinationId: String(req.destinationId ?? ''),
      jdate: String(req.jdate ?? ''),
      serviceKey: String(req.serviceKey ?? ''),
      operatorId: String(req.operatorId ?? ''),
    });
    ui.setStatus('');
    if (outcome.ok) {
      const seatData = {
        ...outcome.result,
        operator: outcome.result.operator || req.operator,
        busType: outcome.result.busType || req.busType,
        searchUrl: req.searchUrl,
      };
      ui.addSeatMap(seatData);
      record({ kind: 'seats', data: seatData });
    } else {
      ui.showError(
        'Could not load the seat chart — the operator\'s reservation system may be ' +
          'offline. Use "Open these results on AbhiBus" to pick seats on the site.',
      );
    }
  }

  function handleReset() {
    state.history = [];
    state.lastPrompt = '';
    state.sessionId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    state.transcript = [];
    state.lastSearchArgs = null;
    state.pendingPage = null;
    NS.pageBridge.clearChat();
    ui.hideSearchOverlay();
    state.abort?.abort();
    state.abort = null;
    ui.setBusy(false);
    ui.setFootnote('');
    refreshSubtitle();
    showWelcome();
  }

  /* =====================================================================
   * Send
   * =================================================================== */

  async function handleSend(rawText, { replay = false } = {}) {
    const text = String(rawText || '').trim();
    if (!text) return;

    // Re-check the gateway's UI flags on EVERY turn, not just at page boot:
    // a SHOW_BUS_LIST_UI flip (or a boot-time fetch that failed) must take
    // effect on the next message, never linger stale for the tab's lifetime.
    await NS.loadUiConfig();

    state.lastPrompt = text;
    if (!replay) {
      ui.addUserMessage(text);
      remember('user', text);
      record({ kind: 'user', text });
    }

    ui.setBusy(true);
    ui.setFootnote('');
    ui.setStatus('Working');

    /* ---- Path 1: local pre-route ------------------------------------ */
    const fast = await NS.preRouter.run(text);

    if (fast.handled) {
      const bubble = ui.startAssistantMessage();
      bubble.set(fast.text);
      bubble.finish();
      remember('assistant', fast.text);
      record({ kind: 'assistant', text: fast.text });
      ui.setStatus('');
      ui.setFootnote(`Answered locally in ${fast.elapsedMs} ms`);
      ui.setBusy(false);
      ui.flagAttention();
      return;
    }

    // A logged-out fast path is a definite answer, not a reason to ask a model.
    if (fast.error?.code === NS.UNAUTHENTICATED) {
      ui.setStatus('');
      ui.setBusy(false);
      ui.showLoginRequired(
        'This needs your AbhiBus account, and the session in this tab has expired.',
      );
      refreshSubtitle();
      return;
    }

    /* ---- Path 2: the model ------------------------------------------ */
    await runAgent(text);
  }

  /** With the bus-list UI off, the stand-in note shows once per turn even if
   *  the model legitimately searches twice (e.g. a filtered retry). */
  const NO_CARD_NOTE =
    'Your buses are pulling up on the page right behind me — a chat window is ' +
    'no place to park a whole fleet. 🚌 Ask me for the cheapest, the fastest, ' +
    'or anything else about them.';

  async function runAgent(text) {
    const bubble = ui.startAssistantMessage();
    let sawLoginError = false;
    let busNoteShown = false;

    state.abort = new AbortController();

    await NS.agentClient.streamChat({
      sessionId: state.sessionId,
      message: text,
      history: state.history.slice(0, -1), // the new turn is sent separately
      pageContext: pageContext(),
      signal: state.abort.signal,
      on: {
        meta({ model }) {
          ui.setSubtitle(model);
        },

        status(stateName, detail) {
          ui.setStatus(detail || STATUS_LABELS[stateName] || '');
        },

        text(chunk) {
          bubble.append(chunk);
        },

        toolStart(name, args) {
          // The search arguments carry the model's `filter` ("ac sleeper"),
          // which feeds the automatic on-page filters after the search.
          if (name === 'searchBuses') {
            state.lastSearchArgs = args || null;
            // Page-only flow: the AI overlay takes the stage and the chat
            // steps aside IMMEDIATELY — only the loader is on screen.
            // "Understanding your request" is already done — the model just
            // proved it by calling the tool with parsed cities and date.
            if (!NS.CONFIG.showBusListUi) {
              ui.close();
              ui.showSearchOverlay({
                route:
                  args?.source && args?.destination
                    ? `${args.source} → ${args.destination}`
                    : '',
                date: args?.jdate || '',
                steps: SEARCH_STEPS,
                doneThrough: 0,
              });
            }
          }
          // Tool activity lives in the status line under the panel, not as
          // chips inside the conversation — the log stays pure Q&A.
          ui.setStatus(`${TOOL_LABELS[name] || name}…`);
        },

        toolEnd(name, ok, error, result) {
          ui.setStatus(ok ? '' : `${TOOL_LABELS[name] || name} · ${error?.code || 'failed'}`);
          // Bus results get a rich card built from the data itself; the
          // model's streamed text then just has to name its pick.
          // capForModel may have rewrapped the services array as
          // { truncated, items: [...] } when the result was large — accept
          // both shapes, and never let a render error kill the SSE handler.
          if (name === 'searchBuses' && ok && result) {
            const services = Array.isArray(result.services)
              ? result.services
              : Array.isArray(result.services?.items)
                ? result.services.items
                : [];
            // In single-API-call mode (SHOW_BUS_LIST_UI=no) the extension
            // skips its own fetch and returns { fetchSkipped: true } instead
            // of services — the results page's own request is the only call.
            const searched = services.length > 0 || result.fetchSkipped === true;

            if (NS.CONFIG.showBusListUi && services.length) {
              try {
                const cardData = { ...result, services };
                ui.addBusResults(cardData);
                record({ kind: 'buses', data: cardData });
              } catch (renderErr) {
                // Always visible — a silently missing card cost days of debugging.
                console.error('[abhi-agent] bus card render failed', renderErr);
              }
            } else if (!NS.CONFIG.showBusListUi && searched && !busNoteShown) {
              // The page shows the fleet, the chat just tips its hat —
              // recorded so the reopened history has it.
              busNoteShown = true;
              const note = ui.startAssistantMessage();
              note.set(NO_CARD_NOTE);
              note.finish();
              record({ kind: 'assistant', text: NO_CARD_NOTE });
            }

            // Queue the page itself to show these results once the answer
            // finishes streaming; the chat survives the navigation.
            if (searched && !NS.CONFIG.showBusListUi) ui.advanceSearchOverlay(1);

            if (searched && typeof result.searchUrl === 'string') {
              state.pendingPage = {
                url: result.searchUrl,
                intent: NS.pageBridge.deriveFilterIntent(
                  state.lastPrompt,
                  state.lastSearchArgs?.filter ?? result.filter,
                  state.lastSearchArgs?.operator ?? result.operatorFilter,
                ),
                // The overlay resumes with these on the results page.
                route: result.route,
                date: result.date,
              };
            }
          }
          // Model-driven seat lookups get the same card as the row button.
          if (name === 'getSeatLayout' && ok && result?.seats) {
            try {
              ui.addSeatMap(result);
              record({ kind: 'seats', data: result });
            } catch (renderErr) {
              console.error('[abhi-agent] seat map render failed', renderErr);
            }
          }
        },

        error(err) {
          ui.hideSearchOverlay(); // an error must never hide behind the loader
          if (err.requiresLogin || err.code === NS.UNAUTHENTICATED) {
            if (sawLoginError) return; // the tool and the backend both report it
            sawLoginError = true;
            bubble.finish(); // keeps any partial answer; removes an empty bubble
            ui.showLoginRequired(err.message);
            refreshSubtitle();
            return;
          }
          // A mid-stream failure must not delete text already delivered —
          // keep the partial answer and put the error card under it.
          bubble.finish();
          ui.showError(err.message, { retry: true });
        },

        done(info) {
          bubble.finish();
          ui.setStatus('');
          ui.setBusy(false);
          ui.flagAttention();
          state.abort = null;

          if (info?.elapsedMs) {
            ui.setFootnote(`${(info.elapsedMs / 1000).toFixed(1)} s`);
          }
        },
      },
    });

    // Safety net: if `done` never arrived (socket died), do not leave the panel
    // stuck in the busy state forever.
    bubble.finish();
    ui.setBusy(false);
    ui.setStatus('');
    state.abort = null;

    const finalText = bubble.getText().trim();
    if (finalText) {
      remember('assistant', finalText);
      record({ kind: 'assistant', text: finalText });
    }

    // Only after the whole answer is in the log: navigating mid-stream would
    // cut the model off, and the transcript must include its final text.
    await maybeShowResultsOnPage();
  }

  /* =====================================================================
   * Labels
   * =================================================================== */

  const STATUS_LABELS = {
    connecting: 'Connecting',
    thinking: 'Thinking',
    calling_tool: 'Working',
    awaiting_tool_result: 'Reading AbhiBus',
    switching_provider: 'Switching model',
    finalising: 'Writing',
  };

  const TOOL_LABELS = {
    getAbhiCashBalance: 'AbhiCash balance',
    getWalletHistory: 'Wallet history',
    searchBuses: 'Bus search',
    getSeatLayout: 'Seat map',
    getSeatLayoutOffers: 'Offers',
    getSavedPassengers: 'Saved passengers',
    getBookings: 'Bookings',
    getFailedTrips: 'Failed bookings',
    getUserProfile: 'Your profile',
    resolveCityIds: 'City lookup',
    getHelpContent: 'Help articles',
  };

  NS.log('ready — backend:', NS.CONFIG.backendUrl);
})();
