// ==UserScript==
// @name         Arcane Reelax 低於 50 杆自動補滿
// @namespace    https://reelax.cn/
// @version      1.3.0
// @description  使用官方瀏覽器腳本 API，在登入且釣魚批次剩餘少於 50 杆時自動補滿。
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

  const REFILL_BELOW = 50;
  const MIN_CHECK_DELAY_MS = 60_000;
  const MAX_CHECK_DELAY_MS = 2 * 60_000;
  const UNKNOWN_CHECK_DELAY_MS = 60_000;
  const LOG_PREFIX = '[Arcane Reelax 自動補滿]';

  let refillPending = false;
  let statusBadge = null;

  function setStatus(message, state = 'active') {
    if (!statusBadge) {
      statusBadge = document.createElement('div');
      statusBadge.id = 'arcane-reelax-auto-refill-status';
      Object.assign(statusBadge.style, {
        position: 'fixed',
        right: '12px',
        bottom: '12px',
        zIndex: '2147483647',
        padding: '6px 10px',
        borderRadius: '8px',
        color: '#fff',
        font: '12px/1.4 system-ui, sans-serif',
        boxShadow: '0 2px 8px #0006',
        pointerEvents: 'none',
        opacity: '0.88',
      });
      document.documentElement.append(statusBadge);
    }
    statusBadge.style.background = state === 'error' ? '#b42318' : '#176b73';
    statusBadge.textContent = `自動補滿 v1.3.0｜${message}`;
  }
  async function getGameApi() {
    if (window.arcaneReelax) {
      await window.arcaneReelax.ready;
      return window.arcaneReelax;
    }

    return new Promise((resolve) => {
      document.addEventListener(
        'arcane-reelax:ready',
        async () => {
          await window.arcaneReelax.ready;
          resolve(window.arcaneReelax);
        },
        { once: true },
      );
    });
  }

  function isEligible(fishing) {
    if (!fishing) return false;
    if (fishing.status !== 'running' && fishing.status !== 'completed') return false;
    if (!Number.isFinite(fishing.remainingCasts)) return false;
    return fishing.remainingCasts < REFILL_BELOW;
  }

  function getNextCheckDelay(game) {
    const fishing = game.getSnapshot()?.fishing;
    if (!fishing || fishing.status !== 'running') return UNKNOWN_CHECK_DELAY_MS;
    if (!Number.isFinite(fishing.remainingCasts)) return UNKNOWN_CHECK_DELAY_MS;
    if (!Number.isFinite(fishing.cycleDurationMs) || fishing.cycleDurationMs <= 0) {
      return UNKNOWN_CHECK_DELAY_MS;
    }

    // 直接睡到預估剩餘 49 杆的時間附近，不做高頻輪詢。
    const castsUntilThreshold = Math.max(0, fishing.remainingCasts - (REFILL_BELOW - 1));
    return Math.min(
      MAX_CHECK_DELAY_MS,
      Math.max(
        MIN_CHECK_DELAY_MS,
        castsUntilThreshold * fishing.cycleDurationMs + 2_000,
      ),
    );
  }

  async function checkAndRefill(game) {
    if (refillPending) return;

    const snapshot = game.getSnapshot();
    if (!snapshot) {
      setStatus('等待登入／遊戲狀態');
      return;
    }

    const fishing = snapshot.fishing;
    if (!isEligible(fishing)) {
      const remaining = Number.isFinite(fishing?.remainingCasts)
        ? `${fishing.remainingCasts} 杆`
        : '等待釣魚批次';
      setStatus(remaining);
      return;
    }

    refillPending = true;
    setStatus(`剩餘 ${fishing.remainingCasts} 杆，補滿中`);
    try {
      const didRefill = await game.fishing.refill();
      if (didRefill) {
        setStatus(`已補滿至 ${fishing.totalCasts} 杆`);
        console.info(
          LOG_PREFIX,
          `剩餘 ${fishing.remainingCasts} 杆，已透過官方 API 補滿至 ${fishing.totalCasts} 杆。`,
        );
      }
    } catch (error) {
      setStatus(error?.message ?? '補滿失敗', 'error');
      console.warn(LOG_PREFIX, error?.code ?? 'REFILL_FAILED', error?.message ?? error);
    } finally {
      refillPending = false;
    }
  }

  async function start() {
    setStatus('等待官方 API');
    const game = await getGameApi();

    if (game.apiVersion !== 1) {
      console.warn(LOG_PREFIX, `未測試的腳本 API 版本：${game.apiVersion}`);
    }

    let timerId = null;
    const scheduleNextCheck = () => {
      if (timerId !== null) window.clearTimeout(timerId);
      const delay = getNextCheckDelay(game);
      timerId = window.setTimeout(async () => {
        timerId = null;
        await checkAndRefill(game);
        scheduleNextCheck();
      }, delay);
    };

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      void checkAndRefill(game).finally(scheduleNextCheck);
    });

    await checkAndRefill(game);
    scheduleNextCheck();

    console.info(
      LOG_PREFIX,
      `已啟動；依單杆週期安排檢查（最長 2 分鐘校正），剩餘少於 ${REFILL_BELOW} 杆時補滿。`,
    );
  }

  void start().catch((error) => {
    console.error(LOG_PREFIX, '啟動失敗：', error);
  });
})();
