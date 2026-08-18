// ==UserScript==
// @name         Arcane Reelax 航線助手＋低於 50 杆自動補滿
// @namespace    https://reelax.cn/
// @version      2.0.2
// @description  使用官方瀏覽器腳本 API，自動處理比賽、金風、經驗航線、場景魚餌、簽到及低於 50 杆補滿。
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

  const VERSION = '2.0.2';
  const REFILL_BELOW = 50;
  const EVALUATE_INTERVAL_MS = 60_000;
  const BOUNDARY_JITTER_MS = 10_000;
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
    autoTravel: true,
    autoBait: false,
    autoCheckIn: false,
    leaderPartyTravel: true,
    helmsmanPartyTravel: false,
    priorities: ['competition', 'golden', 'experience'],
    baitByScene: {
      personalCompetition: '', guildCompetition: '', golden: '', arcaneSurge: '', normal: '',
    },
    collapsed: false,
  };

  if (window.__arcaneReelaxRouteHelperV2) return;
  window.__arcaneReelaxRouteHelperV2 = true;

  let settings = loadSettings();
  let game = null;
  let busy = false;
  let timerId = null;
  let panel = null;
  let statusNode = null;
  let detailNode = null;

  function loadSettings() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
      return {
        ...DEFAULTS,
        ...saved,
        priorities: Array.isArray(saved.priorities) ? saved.priorities : DEFAULTS.priorities,
        baitByScene: { ...DEFAULTS.baitByScene, ...(saved.baitByScene || {}) },
      };
    } catch {
      return structuredClone(DEFAULTS);
    }
  }

  function saveSettings() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    renderPanel();
    scheduleEvaluation(0);
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

  function checkbox(label, key) {
    return `<div class="arrh-row"><label>${label}</label><input type="checkbox" data-setting="${key}" ${settings[key] ? 'checked' : ''}></div>`;
  }

  function renderPanel() {
    if (!panel) return;
    panel.dataset.collapsed = String(settings.collapsed);
    panel.querySelector('#arrh-toggle').textContent = settings.collapsed ? '展開' : '收合';
    const controls = panel.querySelector('#arrh-controls');
    const baits = game?.getSnapshot()?.baits || [];
    const baitOptions = (selected) => ['<option value="">不自動切換</option>', ...baits.map((bait) =>
      `<option value="${escapeHtml(bait.id)}" ${bait.id === selected ? 'selected' : ''}>${escapeHtml(bait.name)}${bait.quantity === null ? '' : ` (${bait.quantity ?? '?'})`}</option>`,
    )].join('');
    controls.innerHTML = `
      ${checkbox('啟用助手', 'enabled')}${checkbox('自動切換地圖', 'autoTravel')}${checkbox('自動選擇魚餌', 'autoBait')}${checkbox('自動每日簽到', 'autoCheckIn')}
      <hr><b>航線優先順序</b>
      ${settings.priorities.map((key, index) => `<div class="arrh-priority"><span>${index + 1}. ${PRIORITY_LABELS[key]}</span><button data-up="${key}">↑</button><button data-down="${key}">↓</button></div>`).join('')}
      <hr><b>船隊</b>${checkbox('船長自動整船切圖', 'leaderPartyTravel')}${checkbox('舵手自動整船切圖', 'helmsmanPartyTravel')}
      <hr><b>場景魚餌</b>
      ${Object.entries(SCENE_LABELS).map(([key, label]) => `<div class="arrh-row"><label>${label}</label><select data-scene="${key}">${baitOptions(settings.baitByScene[key])}</select></div>`).join('')}
      <div class="arrh-note">切換到其他地圖會結束舊批次並放棄尚未完成的剩餘杆數。自動補滿固定在少於 ${REFILL_BELOW} 杆時執行。</div>`;
    controls.querySelectorAll('[data-setting]').forEach((input) => input.addEventListener('change', () => {
      settings[input.dataset.setting] = input.checked; saveSettings();
    }));
    controls.querySelectorAll('[data-scene]').forEach((select) => select.addEventListener('change', () => {
      settings.baitByScene[select.dataset.scene] = select.value; saveSettings();
    }));
    controls.querySelectorAll('[data-up],[data-down]').forEach((button) => button.addEventListener('click', () => {
      const key = button.dataset.up || button.dataset.down;
      const from = settings.priorities.indexOf(key);
      const to = from + (button.dataset.up ? -1 : 1);
      if (to < 0 || to >= settings.priorities.length) return;
      [settings.priorities[from], settings.priorities[to]] = [settings.priorities[to], settings.priorities[from]];
      saveSettings();
    }));
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
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

  function isGolden(biome) {
    const text = `${biome.weather?.id || ''} ${biome.weather?.name || ''} ${biome.weather?.description || ''}`.toLowerCase();
    return text.includes('金风') || text.includes('金風') || text.includes('golden');
  }

  function isArcaneSurge(biome) {
    const text = `${biome.weather?.id || ''} ${biome.weather?.name || ''}`.toLowerCase();
    return text.includes('奥秘涌流') || text.includes('奧秘湧流') || text.includes('arcane_surge');
  }

  function experienceScore(biome, excludeMastery) {
    const mastery = excludeMastery ? 0 : (biome.masteryExperienceBonusBasisPoints || 0);
    const weather = biome.weather?.experienceBonusBasisPoints || 0;
    const guild = biome.guildBoost?.isActive ? (biome.guildBoost.experienceBonusBasisPoints || 0) : 0;
    return (1 + mastery / 10000) * (1 + weather / 10000) * (1 + guild / 10000);
  }

  function highestLevelStable(biomes, currentId) {
    return [...biomes].sort((a, b) =>
      Number(b.id === currentId) - Number(a.id === currentId) ||
      (b.requiredLevel || 0) - (a.requiredLevel || 0) || String(a.id).localeCompare(String(b.id)),
    )[0] || null;
  }

  function chooseRoute(snapshot) {
    const unlocked = snapshot.biomes.filter((biome) => biome.isUnlocked);
    const current = unlocked.find((biome) => biome.isCurrent);
    const party = snapshot.party;
    const partyController = party?.isInParty && party.canChangeBoatBiome;
    for (const priority of settings.priorities) {
      if (priority === 'competition') {
        const candidates = unlocked.filter((biome) => (biome.activeCompetitions || []).length > 0);
        const target = highestLevelStable(candidates, current?.id);
        if (target) return { target, reason: '比賽', scene: competitionKind(target.activeCompetitions[0]) };
      }
      if (priority === 'golden') {
        const target = highestLevelStable(unlocked.filter(isGolden), current?.id);
        if (target) return { target, reason: '金風', scene: 'golden' };
      }
      if (priority === 'experience' && unlocked.length) {
        const target = [...unlocked].sort((a, b) =>
          experienceScore(b, partyController) - experienceScore(a, partyController) ||
          Number(b.id === current?.id) - Number(a.id === current?.id) ||
          (b.requiredLevel || 0) - (a.requiredLevel || 0) || String(a.id).localeCompare(String(b.id)),
        )[0];
        return { target, reason: '最高經驗', scene: isArcaneSurge(target) ? 'arcaneSurge' : 'normal' };
      }
    }
    return current ? { target: current, reason: '維持目前地圖', scene: isArcaneSurge(current) ? 'arcaneSurge' : 'normal' } : null;
  }

  async function travel(route, snapshot) {
    if (!settings.autoTravel || route.target.isCurrent) return false;
    const party = snapshot.party;
    const role = String(party?.role || '').toLowerCase();
    const isCaptain = role === 'captain' || role === 'leader';
    const useParty = party?.isInParty && party.canChangeBoatBiome &&
      ((isCaptain && settings.leaderPartyTravel) || (role === 'helmsman' && settings.helmsmanPartyTravel));
    if (party?.isInParty && !isCaptain && role !== 'helmsman') return false;
    setStatus(`前往 ${route.target.name}`, route.reason);
    if (useParty) await game.party.travelTo(route.target.id);
    else await game.biomes.travelTo(route.target.id);
    return true;
  }

  async function selectSceneBait(scene, snapshot) {
    if (!settings.autoBait) return false;
    const baitId = settings.baitByScene[scene];
    if (!baitId) return false;
    const bait = snapshot.baits.find((item) => item.id === baitId);
    if (!bait || bait.isSelected || (bait.quantity !== null && bait.quantity <= 0)) return false;
    return game.fishing.selectBait(baitId);
  }

  function checkInDue(snapshot) {
    return Boolean(settings.autoCheckIn && snapshot.dailyCheckIn?.canClaim);
  }

  async function evaluate() {
    if (busy || !settings.enabled || !game) return;
    const snapshot = game.getSnapshot();
    if (!snapshot) { setStatus('等待登入／遊戲狀態'); return; }
    busy = true;
    try {
      const fishing = snapshot.fishing;
      if (fishing && ['running', 'completed'].includes(fishing.status) && fishing.remainingCasts < REFILL_BELOW) {
        setStatus(`剩餘 ${fishing.remainingCasts} 杆，補滿中`);
        if (await game.fishing.refill()) setStatus(`已補滿至 ${fishing.totalCasts} 杆`);
      }
      const route = chooseRoute(snapshot);
      if (route) {
        const moved = await travel(route, snapshot);
        const latest = game.getSnapshot() || snapshot;
        await selectSceneBait(route.scene, latest);
        setStatus(moved ? `已前往 ${route.target.name}` : `目前 ${route.target.name}`, route.reason);
      }
      if (checkInDue(game.getSnapshot() || snapshot) && await game.dailyCheckIn.claim()) {
        game.ui.dismissReminder('daily-check-in');
        setStatus('今日簽到完成');
      }
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
    setStatus('等待官方 API');
    game = await getGameApi();
    renderPanel();
    for (const event of ['weather:changed', 'guild-boost:started', 'guild-boost:ended', 'competition:started']) {
      game.on(event, () => scheduleEvaluation(Math.floor(Math.random() * BOUNDARY_JITTER_MS)));
    }
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') scheduleEvaluation(0);
    });
    await evaluate();
    scheduleEvaluation();
  }

  void start().catch((error) => setStatus(error?.message || '啟動失敗', 'ERROR'));
})();
