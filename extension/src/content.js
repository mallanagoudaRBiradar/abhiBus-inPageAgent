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
  };

  function remember(role, content) {
    if (!content?.trim()) return;
    state.history.push({ role, content });
    if (state.history.length > NS.CONFIG.maxHistoryTurns) {
      state.history = state.history.slice(-NS.CONFIG.maxHistoryTurns);
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
  showWelcome();

  // Honour a toolbar click that landed while we were still loading settings.
  if (toggleQueued) {
    toggleQueued = false;
    ui.toggle();
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
      ui.addSeatMap({
        ...outcome.result,
        operator: outcome.result.operator || req.operator,
        busType: outcome.result.busType || req.busType,
        searchUrl: req.searchUrl,
      });
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

    state.lastPrompt = text;
    if (!replay) {
      ui.addUserMessage(text);
      remember('user', text);
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

  async function runAgent(text) {
    const bubble = ui.startAssistantMessage();
    let sawLoginError = false;

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

        toolStart(name) {
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
            if (services.length) {
              try {
                ui.addBusResults({ ...result, services });
              } catch (renderErr) {
                // Always visible — a silently missing card cost days of debugging.
                console.error('[abhi-agent] bus card render failed', renderErr);
              }
            }
          }
          // Model-driven seat lookups get the same card as the row button.
          if (name === 'getSeatLayout' && ok && result?.seats) {
            try {
              ui.addSeatMap(result);
            } catch (renderErr) {
              console.error('[abhi-agent] seat map render failed', renderErr);
            }
          }
        },

        error(err) {
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
    if (finalText) remember('assistant', finalText);
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
