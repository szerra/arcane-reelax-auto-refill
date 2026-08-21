// ==UserScript==
// @name         Arcane Reelax 航線助手＋低於 50 杆自動補滿
// @namespace    https://reelax.cn/
// @version      2.2.0
// @description  使用官方瀏覽器腳本 API 與遊戲內航線設定，自動處理航線、魚餌、簽到及低於 50 杆補滿。
// @author       FishSnack
// @match        https://reelax.cn/*
// @match        https://reelax.abang666.com/*
// @downloadURL  https://raw.githubusercontent.com/szerra/arcane-reelax-auto-refill/main/arcane_reelax_auto_refill_50.user.js
// @updateURL    https://raw.githubusercontent.com/szerra/arcane-reelax-auto-refill/main/arcane_reelax_auto_refill_50.user.js
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(() => {
  'use strict';

  const VERSION = '2.2.0';
  const REFILL_BELOW = 50;
  const EVALUATE_INTERVAL_MS = 60_000;
  const CHECK_IN_INTERVAL_MS = 1_000;
  const ROUTE_RETRY_INTERVAL_MS = 30_000;
  const MAX_TIMER_MS = 2_147_000_000;
  const STORAGE_KEY = 'arcane-reelax-route-helper-v2';
  const LOG_PREFIX = '[Arcane Reelax 航線助手]';
  const PRIORITY_LABELS = { competition: '比賽', golden: '金風', experience: '經驗' };
  const SCENE_LABELS = {
    personalCompetition: '個人賽',
    guildCompetition: '公會賽',
    golden: '金風',
    arcaneSurge: '奧秘湧流',
    normal: '普通天氣',
  };
  const DEFAULTS = {
    enabled: true,
    collapsed: false,
  };

  if (window.__arcaneReelaxRouteHelperV2) return;
  window.__arcaneReelaxRouteHelperV2 = true;

  let settings = loadSettings();
  let game = null;
  let busy = false;
  let checkInBusy = false;
  let baitBusy = false;
  let routeBusy = false;
  let timerId = null;
  let routeTimerId = null;
  let routeDueAt = Number.POSITIVE_INFINITY;
  let lastRouteResult = null;
  let panel = null;
  let statusNode = null;
  let detailNode = null;
  let levelExperience = null;

  function loadSettings() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
      return {
        ...DEFAULTS,
        enabled: typeof saved.enabled === 'boolean' ? saved.enabled : DEFAULTS.enabled,
        collapsed: typeof saved.collapsed === 'boolean' ? saved.collapsed : DEFAULTS.collapsed,
      };
    } catch {
      return structuredClone(DEFAULTS);
    }
  }

  function saveSettings() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    renderPanel();
    scheduleEvaluation(0);
    scheduleRouteEvaluation(0);
  }

  function setStatus(message, detail = '') {
    if (statusNode) statusNode.textContent = message;
    if (detailNode) detailNode.textContent = detail;
    console.info(LOG_PREFIX, message, detail);
  }

  function createPanel() {
    panel = document.createElement('section');
    panel.id = 'arcane-reelax-route-helper';
    panel.innerHTML = `
      <style>
        #arcane-reelax-route-helper{position:fixed;right:12px;bottom:12px;z-index:2147483647;width:310px;color:#eefafa;background:#123c43f2;border:1px solid #4d929b;border-radius:12px;box-shadow:0 5px 18px #0008;font:13px/1.4 system-ui,sans-serif;overflow:hidden}
        #arcane-reelax-route-helper *{box-sizing:border-box}
        #arrh-head{display:flex;align-items:center;gap:8px;padding:9px 10px;background:#176b73}
        #arrh-head b{flex:1} #arrh-head button,.arrh-row button{cursor:pointer;color:inherit;background:#255f67;border:1px solid #6aaab1;border-radius:6px;padding:3px 7px}
        #arrh-body{padding:9px 10px;max-height:65vh;overflow:auto} #arrh-status{font-weight:700;color:#9ff3c5} #arrh-detail{font-size:11px;color:#b9d7db;margin:2px 0 8px}
        .arrh-row{display:flex;align-items:center;gap:6px;margin:6px 0}.arrh-row label{flex:1}.arrh-row select{max-width:155px;color:#eefafa;background:#164c54;border:1px solid #548f97;border-radius:5px;padding:3px}
        .arrh-priority{display:grid;grid-template-columns:1fr auto auto;gap:5px;margin:4px 0}.arrh-note{font-size:11px;color:#f2cf88;margin-top:8px}
        #arcane-reelax-route-helper[data-collapsed="true"] #arrh-body{display:none}
        .arrh-level-experience{margin-left:18px;color:#a9bec7;font-size:11px;font-weight:500;white-space:nowrap}
      </style>
      <header id="arrh-head"><b>航線助手 v${VERSION}</b><button id="arrh-toggle">收合</button></header>
      <div id="arrh-body"><div id="arrh-status">初始化</div><div id="arrh-detail"></div><div id="arrh-controls"></div></div>`;
    document.documentElement.append(panel);
    statusNode = panel.querySelector('#arrh-status');
    detailNode = panel.querySelector('#arrh-detail');
    panel.querySelector('#arrh-toggle').addEventListener('click', () => {
      settings.collapsed = !settings.collapsed;
      saveSettings();
    });
    renderPanel();
  }

  function renderPanel() {
    if (!panel) return;
    panel.dataset.collapsed = String(settings.collapsed);
    panel.querySelector('#arrh-toggle').textContent = settings.collapsed ? '展開' : '收合';
    const controls = panel.querySelector('#arrh-controls');
    const snapshot = game?.getSnapshot?.() || null;
    const shared = game?.routeAssistant?.getSettings?.() || null;
    const priorities = (shared?.priorities || []).map((key) => PRIORITY_LABELS[key] || key).join(' → ') || '尚未讀取';
    const baitNames = new Map((snapshot?.baits || []).map((bait) => [bait.id, bait.name]));
    const baitSummary = shared ? Object.entries(SCENE_LABELS).map(([scene, label]) => {
      const baitId = shared.baitByScene?.[scene];
      return `${escapeHtml(label)}：${escapeHtml(baitId ? (baitNames.get(baitId) || baitId) : '關閉')}`;
    }).join('<br>') : '尚未讀取';
    const executor = !shared ? '等待遊戲狀態' : shared.isOperational ? '遊戲內付費助手' : '本插件';
    const routeTarget = snapshot?.biomes?.find((biome) => biome.id === lastRouteResult?.targetBiomeId);
    const routePlan = routeTarget?.name || lastRouteResult?.targetBiomeId || '尚未申請';
    controls.innerHTML = `
      <div class="arrh-row"><label>啟用插件</label><input type="checkbox" data-setting="enabled" ${settings.enabled ? 'checked' : ''}></div>
      <div class="arrh-row"><label>遊戲航線設定</label><button id="arrh-open-settings">開啟設定</button></div>
      <hr><b>目前執行者</b><div class="arrh-note">${escapeHtml(executor)}</div>
      <hr><b>共享設定</b>
      <div class="arrh-note">自動切圖：${shared?.isAutoTravelEnabled ? '開' : '關'}　自動魚餌：${shared?.isAutoBaitEnabled ? '開' : '關'}　自動簽到：${shared?.isAutoCheckInEnabled ? '開' : '關'}<br>全員解鎖限制：${shared?.isPartyAllMembersUnlockedOnly ? '開' : '關'}<br>優先順序：${escapeHtml(priorities)}<br>服務端航線：${escapeHtml(routePlan)}</div>
      <hr><b>場景魚餌</b><div class="arrh-note">${baitSummary}</div>
      <div class="arrh-note">切圖由官方服務端決定並遵守船隊與比賽規則；付費內建助手運作時，插件會暫停切圖、魚餌與簽到。低於 ${REFILL_BELOW} 杆補滿仍由插件執行。</div>`;
    controls.querySelectorAll('[data-setting]').forEach((input) => input.addEventListener('change', () => {
      settings[input.dataset.setting] = input.checked; saveSettings();
    }));
    controls.querySelector('#arrh-open-settings')?.addEventListener('click', () => {
      if (!game?.routeAssistant?.openSettings?.()) setStatus('目前遊戲版本無法開啟航線設定', 'UNAVAILABLE');
    });
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  }

  function renderLevelExperience() {
    if (!levelExperience) return;
    const levelNode = document.querySelector('.player-progress-heading .player-name-level');
    if (!levelNode) return;
    let experienceNode = levelNode.parentElement?.querySelector('.arrh-level-experience');
    if (!experienceNode) {
      experienceNode = document.createElement('span');
      experienceNode.className = 'arrh-level-experience';
      levelNode.insertAdjacentElement('afterend', experienceNode);
    }
    const text = `${levelExperience.current.toLocaleString('zh-TW')} / ${levelExperience.required.toLocaleString('zh-TW')}`;
    if (experienceNode.textContent !== text) experienceNode.textContent = text;
  }

  function syncLevelExperienceFromPage() {
    const progressNode = document.querySelector('.player-progress');
    if (!progressNode) return;
    const fiberKey = Object.keys(progressNode).find((key) => key.startsWith('__reactFiber$'));
    let fiber = fiberKey ? progressNode[fiberKey] : null;
    for (let depth = 0; fiber && depth < 30; depth += 1, fiber = fiber.return) {
      const candidates = [fiber.memoizedProps, fiber.pendingProps];
      for (const props of candidates) {
        const player = props?.session?.player;
        const current = Number(player?.experience);
        const required = Number(player?.experienceToNextLevel);
        if (!Number.isSafeInteger(current) || !Number.isSafeInteger(required) || required <= 0) continue;
        if (!levelExperience || levelExperience.current !== current || levelExperience.required !== required) {
          levelExperience = { current, required };
          renderLevelExperience();
        }
        return;
      }
    }
  }

  async function loadLevelExperience() {
    try {
      const response = await fetch('/api/me', {
        credentials: 'include',
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) return;
      const data = await response.json();
      const player = data?.player || data;
      const current = Number(player?.experience);
      const required = Number(player?.experienceToNextLevel);
      if (!Number.isSafeInteger(current) || !Number.isSafeInteger(required) || required <= 0) return;
      levelExperience = { current, required };
      renderLevelExperience();
    } catch (error) {
      console.debug(LOG_PREFIX, '讀取等級經驗失敗', error);
    }
  }

  async function getGameApi() {
    if (!window.arcaneReelax) await new Promise((resolve) => document.addEventListener('arcane-reelax:ready', resolve, { once: true }));
    await window.arcaneReelax.ready;
    return window.arcaneReelax;
  }

  function competitionKind(competition) {
    const kind = String(competition?.kind || '').toLowerCase();
    return kind.includes('guild') ? 'guildCompetition' : 'personalCompetition';
  }

  function currentScene(snapshot) {
    const current = snapshot.biomes.find((biome) => biome.id === snapshot.currentBiomeId) ||
      snapshot.biomes.find((biome) => biome.isCurrent);
    if (!current) return 'normal';
    const competitions = current.activeCompetitions || [];
    if (competitions.some((competition) => competitionKind(competition) === 'personalCompetition')) return 'personalCompetition';
    if (competitions.some((competition) => competitionKind(competition) === 'guildCompetition')) return 'guildCompetition';
    if (isGolden(current)) return 'golden';
    return isArcaneSurge(current) ? 'arcaneSurge' : 'normal';
  }

  function isGolden(biome) {
    const text = `${biome.weather?.id || ''} ${biome.weather?.name || ''} ${biome.weather?.description || ''}`.toLowerCase();
    return biome.weather?.id === 'gilded_current' || text.includes('金风') || text.includes('金風') || text.includes('golden');
  }

  function isArcaneSurge(biome) {
    const text = `${biome.weather?.id || ''} ${biome.weather?.name || ''}`.toLowerCase();
    return text.includes('奥秘涌流') || text.includes('奧秘湧流') || text.includes('arcane_surge');
  }

  function getSharedSettings() {
    return game?.routeAssistant?.getSettings?.() || null;
  }

  function clearRouteTimer() {
    if (routeTimerId !== null) clearTimeout(routeTimerId);
    routeTimerId = null;
    routeDueAt = Number.POSITIVE_INFINITY;
  }

  function scheduleRouteEvaluation(delay = 0) {
    const dueAt = Date.now() + Math.max(0, delay);
    if (routeTimerId !== null && routeDueAt <= dueAt) return;
    clearRouteTimer();
    routeDueAt = dueAt;
    routeTimerId = setTimeout(() => {
      routeTimerId = null;
      routeDueAt = Number.POSITIVE_INFINITY;
      void requestServerRoute();
    }, Math.min(Math.max(0, delay), MAX_TIMER_MS));
  }

  function scheduleRouteFromResult(result) {
    const serverNow = Date.parse(result?.serverTime || '');
    if (!Number.isFinite(serverNow)) return;
    const wakeAt = [result.executeAt, result.reevaluateAt]
      .map((value) => value ? Date.parse(value) : Number.NaN)
      .filter((value) => Number.isFinite(value) && value > serverNow)
      .sort((left, right) => left - right)[0];
    if (wakeAt !== undefined) scheduleRouteEvaluation(wakeAt - serverNow);
  }

  async function requestServerRoute() {
    const shared = getSharedSettings();
    if (!settings.enabled || routeBusy || !game || !shared) return false;
    if (shared.isOperational || !shared.isAutoTravelEnabled) {
      clearRouteTimer();
      renderPanel();
      return false;
    }
    routeBusy = true;
    setStatus('向服務端申請航線');
    try {
      const result = await game.routeAssistant.travel();
      lastRouteResult = result;
      scheduleRouteFromResult(result);
      const latest = game.getSnapshot();
      const target = latest?.biomes?.find((biome) => biome.id === result.targetBiomeId);
      const targetName = target?.name || result.targetBiomeId || '目標地圖';
      const reason = PRIORITY_LABELS[result.reason] || '航線';
      if (result.status === 'traveled') setStatus(`已前往 ${targetName}`, reason);
      else if (result.status === 'deferred') setStatus(`已排定前往 ${targetName}`, reason);
      else if (result.status === 'unchanged') setStatus(`目前 ${targetName}`, reason);
      else setStatus('服務端目前沒有航線目標');
      if (result.reason === 'competition' && result.status !== 'deferred') game.ui?.dismissReminder?.('competition');
      if (latest) await selectSceneBait(currentScene(latest), latest);
      renderPanel();
      return result.status === 'traveled';
    } catch (error) {
      setStatus(error?.message || '自動切圖失敗', error?.code || 'ERROR');
      scheduleRouteEvaluation(ROUTE_RETRY_INTERVAL_MS);
      console.warn(LOG_PREFIX, error);
      return false;
    } finally {
      routeBusy = false;
    }
  }

  async function selectSceneBait(scene, snapshot) {
    const shared = getSharedSettings();
    if (baitBusy || !settings.enabled || !shared || shared.isOperational || !shared.isAutoBaitEnabled) return false;
    const baitId = shared.baitByScene?.[scene];
    if (!baitId) return false;
    const bait = snapshot.baits.find((item) => item.id === baitId);
    if (!bait || bait.isSelected || (bait.quantity !== null && bait.quantity <= 0)) return false;
    baitBusy = true;
    try {
      const didSelect = await game.fishing.selectBait(baitId);
      if (didSelect) setStatus(`已切換 ${bait.name}`, SCENE_LABELS[scene] || '魚餌');
      return didSelect;
    } catch (error) {
      setStatus(error?.message || '自動切換魚餌失敗', error?.code || 'ERROR');
      console.warn(LOG_PREFIX, error);
      return false;
    } finally {
      baitBusy = false;
    }
  }

  function checkInDue(snapshot) {
    const shared = getSharedSettings();
    return Boolean(shared && !shared.isOperational && shared.isAutoCheckInEnabled && snapshot.dailyCheckIn?.canClaim);
  }

  async function claimDailyCheckIn(snapshot = game?.getSnapshot()) {
    if (checkInBusy || !settings.enabled || !game || !snapshot || !checkInDue(snapshot)) return false;
    checkInBusy = true;
    try {
      if (!await game.dailyCheckIn.claim()) return false;
      game.ui.dismissReminder('daily-check-in');
      setStatus('今日簽到完成');
      return true;
    } catch (error) {
      setStatus(error?.message || '簽到失敗', error?.code || 'ERROR');
      console.warn(LOG_PREFIX, error);
      return false;
    } finally {
      checkInBusy = false;
    }
  }

  async function evaluate() {
    if (busy || !settings.enabled || !game) return;
    const snapshot = game.getSnapshot();
    if (!snapshot) { setStatus('等待登入／遊戲狀態'); return; }
    busy = true;
    try {
      await claimDailyCheckIn(snapshot);
      const fishing = snapshot.fishing;
      if (fishing && ['running', 'completed'].includes(fishing.status) && fishing.remainingCasts < REFILL_BELOW) {
        setStatus(`剩餘 ${fishing.remainingCasts} 杆，補滿中`);
        if (await game.fishing.refill()) setStatus(`已補滿至 ${fishing.totalCasts} 杆`);
        else setStatus(`剩餘 ${fishing.remainingCasts} 杆`, '尚未達官方補滿門檻');
      }
      const latest = game.getSnapshot() || snapshot;
      await selectSceneBait(currentScene(latest), latest);
      renderPanel();
    } catch (error) {
      setStatus(error?.message || '操作失敗', error?.code || 'ERROR');
      console.warn(LOG_PREFIX, error);
    } finally {
      busy = false;
    }
  }

  function scheduleEvaluation(delay = EVALUATE_INTERVAL_MS) {
    if (timerId !== null) clearTimeout(timerId);
    timerId = setTimeout(async () => { timerId = null; await evaluate(); scheduleEvaluation(); }, delay);
  }

  async function start() {
    createPanel();
    const levelObserver = new MutationObserver(renderLevelExperience);
    levelObserver.observe(document.documentElement, { childList: true, subtree: true });
    void loadLevelExperience();
    syncLevelExperienceFromPage();
    setInterval(syncLevelExperienceFromPage, 1_000);
    setStatus('等待官方 API');
    game = await getGameApi();
    if (game.apiVersion !== 2 || !game.routeAssistant?.travel || !game.routeAssistant?.getSettings) {
      throw new Error(`不支援的官方 API 版本：${game.apiVersion ?? '未知'}`);
    }
    renderPanel();
    for (const event of ['weather:changed', 'guild-boost:started', 'guild-boost:ended', 'competition:started']) {
      game.on(event, () => {
        scheduleEvaluation(0);
        scheduleRouteEvaluation(0);
      });
    }
    game.on('route-assistant:settings-changed', () => {
      renderPanel();
      scheduleEvaluation(0);
      scheduleRouteEvaluation(0);
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        scheduleEvaluation(0);
        scheduleRouteEvaluation(0);
      }
    });
    setInterval(() => { void claimDailyCheckIn(); }, CHECK_IN_INTERVAL_MS);
    await evaluate();
    scheduleRouteEvaluation(0);
    scheduleEvaluation();
  }

  void start().catch((error) => setStatus(error?.message || '啟動失敗', 'ERROR'));
})();
