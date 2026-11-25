import { speakText } from "./tts.js";
import {
  DEFAULT_VOCAB_PATH,
  AVAILABLE_VOCAB_FILES,
  buildReviewFilePath,
  extractFileName,
  downloadJson,
  discoverAndLoadVocab,
  loadVocabAndReview
} from "./vocab-loader.js";

const STAGES = {
      new: { label: "未學習 (new)", weight: 4, cooldownMs: 0 },
      unfamiliar: { label: "不熟悉 (unfamiliar)", weight: 8, cooldownMs: 10 * 60 * 1000 },
      learning: { label: "學習中 (learning)", weight: 5, cooldownMs: 24 * 60 * 60 * 1000 },
      reviewing: { label: "複習驗證 (reviewing)", weight: 3, cooldownMs: 3 * 24 * 60 * 60 * 1000 },
      mastered: { label: "確定記住 (mastered)", weight: 1, cooldownMs: 7 * 24 * 60 * 60 * 1000 }
    };

    const state = {
      vocabPath: DEFAULT_VOCAB_PATH,
      availableVocabFiles: [...AVAILABLE_VOCAB_FILES],
      reviewPath: buildReviewFilePath(DEFAULT_VOCAB_PATH),
      reviewAutoStatusText: "尚未載入",
      hasNewRecords: false,
      newEventCount: 0,
      lastRecordAt: null,
      schemaVersion: "1.0.0",
      activePackId: null,
      practiceMode: "pack", // "pack" | "all_random"
      packs: [],
      progressByWordId: {},
      currentWordId: null,
      showChinese: false,
      peekedCurrentWord: false,
      dueOnlyPriority: true,
      metaExpanded: false,
      showCollocations: true,
      showSentences: true,
      showMasteryProgress: false,
      sessionEvents: []
    };

    const els = {
      vocabFileSelect: document.getElementById("vocabFileSelect"),
      reviewPathCode: document.getElementById("reviewPathCode"),
      reviewAutoStatus: document.getElementById("reviewAutoStatus"),
      unsavedRecordBadge: document.getElementById("unsavedRecordBadge"),
      toggleMetaPanelBtn: document.getElementById("toggleMetaPanelBtn"),
      metaCollapsibleBody: document.getElementById("metaCollapsibleBody"),
      downloadProgressBtn: document.getElementById("downloadProgressBtn"),
      toggleImmersionBtn: document.getElementById("toggleImmersionBtn"),
      toggleDueOnlyBtn: document.getElementById("toggleDueOnlyBtn"),
      toggleLogViewBtn: document.getElementById("toggleLogViewBtn"),
      modePackBtn: document.getElementById("modePackBtn"),
      modeAllRandomBtn: document.getElementById("modeAllRandomBtn"),
      scopeNote: document.getElementById("scopeNote"),
      packSwitcher: document.getElementById("packSwitcher"),
      statsStrip: document.getElementById("statsStrip"),
      statusToast: document.getElementById("statusToast"),
      stageArena: document.getElementById("stageArena"),
      logPanel: document.getElementById("logPanel"),
      logPreview: document.getElementById("logPreview")
    };

    function setStatus(msg, isError = false) {
      els.statusToast.textContent = msg;
      els.statusToast.classList.toggle("error", isError);
    }

    
    
    
    function getActivePack() {
      return state.packs.find((p) => p.pack_id === state.activePackId) || state.packs[0] || null;
    }

    function getAllWords() {
      return state.packs.flatMap((p) => p.words);
    }

    function getScopeWords() {
      if (state.practiceMode === "all_random") {
        return getAllWords();
      }
      const pack = getActivePack();
      return pack ? pack.words : [];
    }

    function ensureProgressEntries() {
      const words = getAllWords();
      words.forEach((w) => {
        if (!state.progressByWordId[w.id]) {
          state.progressByWordId[w.id] = {
            word_id: w.id,
            word: w.word,
            stage: "new",
            streak: 0,
            correctCount: 0,
            wrongCount: 0,
            peekCount: 0,
            nextReviewAt: 0,
            lastReviewedAt: null,
            history: []
          };
        } else {
          state.progressByWordId[w.id].word = w.word;
        }
      });
    }

    function getProgress(wordId) {
      if (!state.progressByWordId[wordId]) {
        state.progressByWordId[wordId] = {
          word_id: wordId,
          word: "",
          stage: "new",
          streak: 0,
          correctCount: 0,
          wrongCount: 0,
          peekCount: 0,
          nextReviewAt: 0,
          lastReviewedAt: null,
          history: []
        };
      }
      return state.progressByWordId[wordId];
    }

    function getPromotionRequirement(prog) {
      switch (prog.stage) {
        case "new":
          return { nextStage: "learning", needStreak: 1, needCorrect: 1, text: "未看中文滑右 1 次即可進入 learning" };
        case "unfamiliar":
          return { nextStage: "learning", needStreak: 2, needCorrect: 1, text: `連續未看中文滑右 ${prog.streak}/2 次升級 learning` };
        case "learning":
          return {
            nextStage: "reviewing",
            needStreak: 2,
            needCorrect: 3,
            text: `連勝 ${prog.streak}/2 且累計有效 ${prog.correctCount}/3 升級 reviewing`
          };
        case "reviewing":
          return {
            nextStage: "mastered",
            needStreak: 3,
            needCorrect: 5,
            text: `連勝 ${prog.streak}/3 且累計有效 ${prog.correctCount}/5 升級 mastered`
          };
        case "mastered":
        default:
          return { nextStage: "mastered", needStreak: 0, needCorrect: 0, text: "已達最高階段 mastered（持續維持間隔複習）" };
      }
    }

    function applyReviewOutcome(word, isKnown) {
      const prog = getProgress(word.id);
      const now = Date.now();
      const peeked = state.peekedCurrentWord;
      let outcomeNote = "";

      if (peeked) {
        prog.peekCount += 1;
      }

      if (isKnown) {
        if (peeked) {
          outcomeNote = "已顯示中文提示，本次僅算練習，不計入連勝與階段晉升";
        } else {
          prog.streak += 1;
          prog.correctCount += 1;

          if (prog.stage === "new" && prog.streak >= 1 && prog.correctCount >= 1) {
            prog.stage = "learning";
            outcomeNote = "晉升為 learning";
          } else if (prog.stage === "unfamiliar" && prog.streak >= 2) {
            prog.stage = "learning";
            prog.streak = 0;
            outcomeNote = "連勝達標，晉升為 learning";
          } else if (prog.stage === "learning" && prog.streak >= 2 && prog.correctCount >= 3) {
            prog.stage = "reviewing";
            prog.streak = 0;
            outcomeNote = "連勝與累計達標，晉升為 reviewing";
          } else if (prog.stage === "reviewing" && prog.streak >= 3 && prog.correctCount >= 5) {
            prog.stage = "mastered";
            prog.streak = 0;
            outcomeNote = "通過嚴格驗證，晉升為 mastered";
          } else {
            outcomeNote = `記錄熟悉（目前連勝 ${prog.streak}，階段 ${prog.stage}）`;
          }

          const cooldown = STAGES[prog.stage]?.cooldownMs || 0;
          prog.nextReviewAt = now + cooldown;
        }
      } else {
        prog.wrongCount += 1;
        prog.streak = 0;
        if (prog.stage === "mastered") {
          prog.stage = "reviewing";
          outcomeNote = "不熟悉：連勝歸零，退回 reviewing 重新驗證";
        } else if (prog.stage === "reviewing") {
          prog.stage = "learning";
          outcomeNote = "不熟悉：連勝歸零，退回 learning";
        } else if (prog.stage === "learning") {
          prog.stage = "unfamiliar";
          outcomeNote = "不熟悉：連勝歸零，退回 unfamiliar";
        } else {
          prog.stage = "unfamiliar";
          outcomeNote = "不熟悉：連勝歸零，維持 unfamiliar";
        }
        prog.nextReviewAt = now;
      }

      prog.lastReviewedAt = new Date(now).toISOString();
      const eventRecord = {
        timestamp: prog.lastReviewedAt,
        word_id: word.id,
        word: word.word,
        action: isKnown ? "swipe_right_known" : "swipe_left_unknown",
        peeked_chinese: peeked,
        resulting_stage: prog.stage,
        streak: prog.streak,
        correctCount: prog.correctCount,
        wrongCount: prog.wrongCount,
        nextReviewAt: prog.nextReviewAt,
        note: outcomeNote
      };

      prog.history.push(eventRecord);
      if (prog.history.length > 30) {
        prog.history = prog.history.slice(-30);
      }
      state.sessionEvents.push(eventRecord);
      state.hasNewRecords = true;
      state.newEventCount += 1;
      state.lastRecordAt = prog.lastReviewedAt;

      state.peekedCurrentWord = false;
      state.showChinese = false;

      pickNextWord(word.id);
      renderAll();
      setStatus(`${word.word}：${outcomeNote}`);
    }

    function pickNextWord(excludeWordId = null) {
      const words = getScopeWords();
      if (!words.length) {
        state.currentWordId = null;
        return;
      }

      const now = Date.now();
      const candidates = words.length > 1 && excludeWordId
        ? words.filter((w) => w.id !== excludeWordId)
        : words;

      const weighted = candidates.map((w) => {
        const prog = getProgress(w.id);
        let weight = STAGES[prog.stage]?.weight ?? 4;
        const isDue = !prog.nextReviewAt || prog.nextReviewAt <= now;
        if (!isDue && state.dueOnlyPriority) {
          weight = Math.max(0.15, weight * 0.15);
        }
        return { word: w, weight };
      });

      const totalWeight = weighted.reduce((sum, item) => sum + item.weight, 0);
      let r = Math.random() * totalWeight;
      let chosen = weighted[weighted.length - 1].word;

      for (const item of weighted) {
        r -= item.weight;
        if (r <= 0) {
          chosen = item.word;
          break;
        }
      }

      state.currentWordId = chosen.id;
      state.peekedCurrentWord = false;
      state.showChinese = false;
    }

    
    function buildProgressExportObject() {
      return {
        schema_version: state.schemaVersion,
        source_vocab_file: state.vocabPath,
        review_file: state.reviewPath,
        has_new_records: state.hasNewRecords,
        new_event_count: state.newEventCount,
        exported_at: new Date().toISOString(),
        progress: state.progressByWordId,
        session_events: state.sessionEvents
      };
    }

    
    function setPracticeMode(mode) {
      state.practiceMode = mode;
      els.modePackBtn.classList.toggle("active", mode === "pack");
      els.modeAllRandomBtn.classList.toggle("active", mode === "all_random");
      els.packSwitcher.classList.toggle("is-disabled", mode === "all_random");

      const totalAll = getAllWords().length;
      const activePack = getActivePack();

      if (mode === "all_random") {
        els.scopeNote.textContent = `目前：全部隨機練習（共 ${totalAll} 字）`;
      } else {
        els.scopeNote.textContent = activePack
          ? `目前：分組練習 — ${activePack.title}（${activePack.words.length} 字）`
          : "目前：分組練習";
      }

      pickNextWord(null);
      renderAll();
      setStatus(
        mode === "all_random"
          ? `已切換為「全部隨機練習」（共 ${totalAll} 字）`
          : `已切換為「分組練習」：${activePack ? activePack.title : ""}`
      );
    }

    function renderVocabFileSelect() {
      const uniqueFiles = Array.from(new Set([state.vocabPath, ...state.availableVocabFiles]));
      state.availableVocabFiles = uniqueFiles;
      els.vocabFileSelect.innerHTML = "";
      uniqueFiles.forEach((filePath) => {
        const opt = document.createElement("option");
        opt.value = filePath;
        opt.textContent = filePath;
        if (filePath === state.vocabPath) opt.selected = true;
        els.vocabFileSelect.appendChild(opt);
      });
    }

    function renderFileHeaderInfo() {
      renderVocabFileSelect();
      els.reviewPathCode.textContent = state.reviewPath;
      els.reviewAutoStatus.textContent = `（${state.reviewAutoStatusText}）`;
      if (state.hasNewRecords) {
        els.unsavedRecordBadge.className = "unsaved-badge";
        els.unsavedRecordBadge.textContent = `● 有新的學習紀錄（+${state.newEventCount} 筆，可下載）`;
      } else {
        els.unsavedRecordBadge.className = "unsaved-badge clean";
        els.unsavedRecordBadge.textContent = "無新紀錄";
      }
    }

    function renderPackSwitcher() {
      els.packSwitcher.innerHTML = "";
      state.packs.forEach((p) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = `pack-chip ${p.pack_id === state.activePackId ? "active" : ""}`;
        btn.textContent = `${p.title} (${p.words.length})`;
        btn.addEventListener("click", () => {
          state.activePackId = p.pack_id;
          if (state.practiceMode !== "pack") {
            setPracticeMode("pack");
            return;
          }
          els.scopeNote.textContent = `目前：分組練習 — ${p.title}（${p.words.length} 字）`;
          ensureProgressEntries();
          pickNextWord(null);
          renderAll();
          setStatus(`已切換至：${p.title}`);
        });
        els.packSwitcher.appendChild(btn);
      });
    }

    function renderStats() {
      const words = getScopeWords();
      const counts = { new: 0, unfamiliar: 0, learning: 0, reviewing: 0, mastered: 0 };
      words.forEach((w) => {
        const st = getProgress(w.id).stage;
        if (counts[st] !== undefined) counts[st] += 1;
      });

      const scopeLabel = state.practiceMode === "all_random" ? "全部" : "本組";

      const items = [
        { label: scopeLabel, value: words.length },
        { label: "new", value: counts.new },
        { label: "unfamiliar", value: counts.unfamiliar },
        { label: "learning", value: counts.learning },
        { label: "reviewing", value: counts.reviewing },
        { label: "mastered", value: counts.mastered }
      ];

      els.statsStrip.innerHTML = items.map((it) => `
        <div class="stat-mini">${escapeHtml(it.label)}<strong>${it.value}</strong></div>
      `).join("");
    }

    function renderCardArena() {
      const words = getScopeWords();
      const currentWord = words.find((w) => w.id === state.currentWordId) || words[0] || null;

      if (!currentWord) {
        els.stageArena.innerHTML = `
          <div class="empty-state">
            <h2>尚未載入單字資料</h2>
            <p>
              系統會自動讀取 <code>${escapeHtml(state.vocabPath)}</code> 與 <code>${escapeHtml(state.reviewPath)}</code>。<br/>
              請確認檔案位於同目錄並透過 HTTP 伺服器開啟。
            </p>
          </div>
        `;
        return;
      }

      const prog = getProgress(currentWord.id);
      const req = getPromotionRequirement(prog);
      const now = Date.now();
      const remainingSec = prog.nextReviewAt && prog.nextReviewAt > now
        ? Math.ceil((prog.nextReviewAt - now) / 1000)
        : 0;

      const cooldownText = remainingSec > 0
        ? `冷卻 ${remainingSec >= 60 ? `${Math.ceil(remainingSec / 60)}m` : `${remainingSec}s`}`
        : "可複習";

      let progressPct = 0;
      if (prog.stage === "mastered") {
        progressPct = 100;
      } else if (prog.stage === "new") {
        progressPct = prog.streak >= 1 ? 100 : 15;
      } else if (prog.stage === "unfamiliar") {
        progressPct = Math.min(100, Math.round((prog.streak / 2) * 100));
      } else if (prog.stage === "learning") {
        const sPct = Math.min(1, prog.streak / 2);
        const cPct = Math.min(1, prog.correctCount / 3);
        progressPct = Math.round(((sPct + cPct) / 2) * 100);
      } else if (prog.stage === "reviewing") {
        const sPct = Math.min(1, prog.streak / 3);
        const cPct = Math.min(1, prog.correctCount / 5);
        progressPct = Math.round(((sPct + cPct) / 2) * 100);
      }

      const zhHiddenClass = state.showChinese ? "" : "hidden";

      const collocationsHtml = currentWord.collocations.length
        ? currentWord.collocations.map((c) => `
            <div class="item-card">
              <div>
                <div class="item-en">${escapeHtml(c.phrase)}</div>
                <div class="item-zh ${zhHiddenClass}">${escapeHtml(c.meaning_zh || "（無中文解釋）")}</div>
              </div>
              <button class="mini-play" type="button" data-speak="${escapeAttribute(c.phrase)}" data-rate="0.95">🔊</button>
            </div>
          `).join("")
        : `<div class="item-zh">尚無組合單字</div>`;

      const sentencesHtml = currentWord.short_sentences.length
        ? currentWord.short_sentences.map((s) => `
            <div class="item-card">
              <div>
                <div class="item-en">${escapeHtml(s.en)}</div>
                <div class="item-zh ${zhHiddenClass}">${escapeHtml(s.zh || "（無中文翻譯）")}</div>
              </div>
              <button class="mini-play" type="button" data-speak="${escapeAttribute(s.en)}" data-rate="0.95">🔊</button>
            </div>
          `).join("")
        : `<div class="item-zh">尚無短句</div>`;

      els.stageArena.innerHTML = `
        <div class="swipe-hint-row">
          <span>⬅️ 滑左 / A / ←：不熟悉</span>
          <span>滑右 / D / →：熟悉 ➡️</span>
        </div>

        <div id="flashcard" class="flashcard">
          <div class="card-top">
            <span class="stage-badge">${STAGES[prog.stage]?.label || prog.stage}</span>
            <div class="meta-pills">
              <span class="pill">連勝 ${prog.streak}</span>
              <span class="pill">有效 ${prog.correctCount}</span>
              <span class="pill">${cooldownText}</span>
              <button id="toggleProgressDetailBtn" class="mini-play" type="button">
                ${state.showMasteryProgress ? "收合門檻" : "晉升條件"}
              </button>
            </div>
          </div>

          <div class="word-row">
            <span class="word-main">${escapeHtml(currentWord.word)}</span>
            ${currentWord.ipa ? `<span class="word-ipa">${escapeHtml(currentWord.ipa)}</span>` : ""}
            ${currentWord.pos ? `<span class="word-pos">${escapeHtml(currentWord.pos)}</span>` : ""}
          </div>

          <div class="audio-row">
            <button id="playWordBtn" type="button">🔊 單字發音 (R)</button>
            <button id="playSlowBtn" type="button">🐢 慢速</button>
            <button id="toggleChineseCardBtn" type="button">
              ${state.showChinese ? "🙈 隱藏中文 (Space)" : "👁️ 顯示中文 (Space)"}
            </button>
          </div>

          <div class="chinese-box">
            ${state.showChinese
              ? `<div>
                   <div class="meaning-zh">${escapeHtml(currentWord.meaning_zh || "（此 JSON 未提供中文釋義）")}</div>
                   <div class="sub-zh">${state.peekedCurrentWord ? "👀 已看中文：本次滑右僅算練習，不計入連勝與晉升。" : ""}</div>
                 </div>`
              : `<div class="chinese-hidden-placeholder">
                   <span>中文已隱藏，先以英文理解與發音。</span>
                   <button id="inlineRevealBtn" type="button">顯示中文</button>
                 </div>`
            }
          </div>

          <div class="section-block">
            <div class="section-header-row">
              <span class="section-title">常用組合單字 (${currentWord.collocations.length})</span>
              <button id="toggleCollocationsBtn" class="mini-play" type="button">
                ${state.showCollocations ? "隱藏" : "展開"}
              </button>
            </div>
            <div class="detail-body ${state.showCollocations ? "" : "collapsed"}">
              <div class="item-list">${collocationsHtml}</div>
            </div>
          </div>

          <div class="section-block">
            <div class="section-header-row">
              <span class="section-title">短句 (${currentWord.short_sentences.length})</span>
              <button id="toggleSentencesBtn" class="mini-play" type="button">
                ${state.showSentences ? "隱藏" : "展開"}
              </button>
            </div>
            <div class="detail-body ${state.showSentences ? "" : "collapsed"}">
              <div class="item-list">${sentencesHtml}</div>
            </div>
          </div>

          <div class="progress-box ${state.showMasteryProgress ? "" : "collapsed"}">
            <div class="progress-header">
              <span>${escapeHtml(req.text)}</span>
              <span>${progressPct}%</span>
            </div>
            <div class="progress-bar">
              <div class="progress-fill" style="width: ${progressPct}%"></div>
            </div>
          </div>
        </div>

        <div class="action-bar">
          <button id="unknownBtn" class="bad-btn" type="button">⬅️ 不熟悉（滑左）</button>
          <button id="skipBtn" type="button">🎲 換一題</button>
          <button id="knownBtn" class="good-btn" type="button">
            ${state.peekedCurrentWord ? "👀 熟悉（僅練習） ➡️" : "熟悉（滑右） ➡️"}
          </button>
        </div>
      `;

      bindCardInteractions(currentWord);
    }

    function bindCardInteractions(currentWord) {
      const card = document.getElementById("flashcard");
      const playWordBtn = document.getElementById("playWordBtn");
      const playSlowBtn = document.getElementById("playSlowBtn");
      const toggleChineseCardBtn = document.getElementById("toggleChineseCardBtn");
      const inlineRevealBtn = document.getElementById("inlineRevealBtn");
      const toggleCollocationsBtn = document.getElementById("toggleCollocationsBtn");
      const toggleSentencesBtn = document.getElementById("toggleSentencesBtn");
      const toggleProgressDetailBtn = document.getElementById("toggleProgressDetailBtn");
      const unknownBtn = document.getElementById("unknownBtn");
      const knownBtn = document.getElementById("knownBtn");
      const skipBtn = document.getElementById("skipBtn");

      const revealOrToggleChinese = () => {
        if (!state.showChinese) {
          state.showChinese = true;
          state.peekedCurrentWord = true;
        } else {
          state.showChinese = false;
        }
        renderCardArena();
      };

      playWordBtn?.addEventListener("click", () => speakText(currentWord.word, 1.0, setStatus));
      playSlowBtn?.addEventListener("click", () => speakText(currentWord.word, 0.72, setStatus));
      toggleChineseCardBtn?.addEventListener("click", revealOrToggleChinese);
      inlineRevealBtn?.addEventListener("click", revealOrToggleChinese);

      toggleCollocationsBtn?.addEventListener("click", () => {
        state.showCollocations = !state.showCollocations;
        renderCardArena();
      });

      toggleSentencesBtn?.addEventListener("click", () => {
        state.showSentences = !state.showSentences;
        renderCardArena();
      });

      toggleProgressDetailBtn?.addEventListener("click", () => {
        state.showMasteryProgress = !state.showMasteryProgress;
        renderCardArena();
      });

      card.querySelectorAll("[data-speak]").forEach((btn) => {
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          speakText(btn.getAttribute("data-speak"), Number(btn.getAttribute("data-rate") || 1.0), setStatus);
        });
      });

      unknownBtn?.addEventListener("click", () => applyReviewOutcome(currentWord, false));
      knownBtn?.addEventListener("click", () => applyReviewOutcome(currentWord, true));
      skipBtn?.addEventListener("click", () => {
        pickNextWord(currentWord.id);
        renderAll();
      });

      let startX = 0;
      let currentX = 0;
      let isPointerDown = false;
      const threshold = 90;

      const onStart = (clientX) => {
        isPointerDown = true;
        startX = clientX;
        currentX = 0;
        card.classList.add("dragging");
      };

      const onMove = (clientX) => {
        if (!isPointerDown) return;
        currentX = clientX - startX;
        const rot = currentX * 0.04;
        card.style.transform = `translateX(${currentX}px) rotate(${rot}deg)`;
        card.classList.toggle("tilt-left", currentX < -25);
        card.classList.toggle("tilt-right", currentX > 25);
      };

      const onEnd = () => {
        if (!isPointerDown) return;
        isPointerDown = false;
        card.classList.remove("dragging", "tilt-left", "tilt-right");
        card.style.transform = "";

        if (currentX > threshold) {
          applyReviewOutcome(currentWord, true);
        } else if (currentX < -threshold) {
          applyReviewOutcome(currentWord, false);
        }
        currentX = 0;
      };

      card.addEventListener("pointerdown", (e) => {
        if (e.target.closest("button")) return;
        card.setPointerCapture(e.pointerId);
        onStart(e.clientX);
      });

      card.addEventListener("pointermove", (e) => onMove(e.clientX));
      card.addEventListener("pointerup", onEnd);
      card.addEventListener("pointercancel", onEnd);
    }

    function renderLogPreview() {
      els.logPreview.textContent = JSON.stringify(buildProgressExportObject(), null, 2);
    }

    function renderAll() {
      renderFileHeaderInfo();
      renderPackSwitcher();
      renderStats();
      renderCardArena();
      renderLogPreview();
    }

    function escapeHtml(str) {
      return String(str ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    }

    function escapeAttribute(str) {
      return String(str ?? "").replace(/"/g, "&quot;");
    }

    
    
    
    


    els.toggleMetaPanelBtn.addEventListener("click", () => {
      state.metaExpanded = !state.metaExpanded;
      els.metaCollapsibleBody.classList.toggle("collapsed", !state.metaExpanded);
      els.toggleMetaPanelBtn.textContent = state.metaExpanded
        ? "▴ 收合組別與統計"
        : "▾ 展開/收合組別與統計";
    });

    els.modePackBtn.addEventListener("click", () => setPracticeMode("pack"));
    els.modeAllRandomBtn.addEventListener("click", () => setPracticeMode("all_random"));

    els.vocabFileSelect.addEventListener("change", async (e) => {
      const chosen = e.target.value;
      if (!chosen || chosen === state.vocabPath) return;
      await loadVocabAndReview(state, chosen, { preserveExistingProgress: true, onStatus: setStatus, onAfterLoad: () => { ensureProgressEntries(); pickNextWord(null); renderAll(); } });
    });

    els.downloadProgressBtn.addEventListener("click", () => {
      const reviewFileName = extractFileName(state.reviewPath);
      downloadJson(reviewFileName, buildProgressExportObject());
      state.hasNewRecords = false;
      state.newEventCount = 0;
      renderFileHeaderInfo();
      renderLogPreview();
      setStatus(`已下載複習紀錄檔案：${reviewFileName}（已更新為無未下載新紀錄）`);
    });

    els.toggleImmersionBtn.addEventListener("click", () => {
      state.showChinese = !state.showChinese;
      if (state.showChinese) {
        state.peekedCurrentWord = true;
      }
      els.toggleImmersionBtn.textContent = state.showChinese ? "👁️ 目前顯示中文：開" : "🙈 預設隱藏中文：開";
      renderCardArena();
    });

    els.toggleDueOnlyBtn.addEventListener("click", () => {
      state.dueOnlyPriority = !state.dueOnlyPriority;
      els.toggleDueOnlyBtn.classList.toggle("active-toggle", state.dueOnlyPriority);
      els.toggleDueOnlyBtn.textContent = state.dueOnlyPriority
        ? "⏳ 到期優先：開"
        : "⏳ 到期優先：關";
      setStatus(state.dueOnlyPriority ? "已啟用到期優先抽題" : "已關閉到期優先抽題");
    });

    els.toggleLogViewBtn.addEventListener("click", () => {
      const isHidden = els.logPanel.style.display === "none";
      els.logPanel.style.display = isHidden ? "block" : "none";
      if (isHidden) renderLogPreview();
    });

    document.addEventListener("keydown", (e) => {
      if (["INPUT", "TEXTAREA"].includes(document.activeElement?.tagName)) return;
      const words = getScopeWords();
      const currentWord = words.find((w) => w.id === state.currentWordId);
      if (!currentWord) return;

      if (e.code === "Space") {
        e.preventDefault();
        if (!state.showChinese) {
          state.showChinese = true;
          state.peekedCurrentWord = true;
        } else {
          state.showChinese = false;
        }
        renderCardArena();
      } else if (e.key === "r" || e.key === "R") {
        speakText(currentWord.word, 1.0, setStatus);
      } else if (e.key === "ArrowRight" || e.key === "d" || e.key === "D") {
        applyReviewOutcome(currentWord, true);
      } else if (e.key === "ArrowLeft" || e.key === "a" || e.key === "A") {
        applyReviewOutcome(currentWord, false);
      }
    });

    discoverAndLoadVocab(state, {
      onStatus: setStatus,
      onAfterLoad: () => {
        ensureProgressEntries();
        pickNextWord(null);
        renderAll();
      }
    });
