export const DEFAULT_VOCAB_PATH = "./verb-1-100_packs.json";
export const AVAILABLE_VOCAB_FILES = [
  "./verb-1-100_packs.json",
  "./verb-101-200_packs.json",
  "./noun-1-100_packs.json",
  "./adj-1-100_packs.json"
];

export function fetchWithTimeout(url, timeoutMs = 4000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { cache: "no-store", signal: controller.signal }).finally(() => {
    clearTimeout(timer);
  });
}

export function ensureTrailingSlash(url) {
  if (!url) return "./";
  return url.endsWith("/") ? url : `${url}/`;
}

export async function loadSiteConfig(configUrl = "./config.json", timeoutMs = 3000) {
  const res = await fetchWithTimeout(configUrl, timeoutMs);
  if (!res.ok) {
    throw new Error(`無法讀取設定檔 ${configUrl}（HTTP ${res.status}）`);
  }
  return res.json();
}

export function buildReviewFilePath(vocabPath) {
  const clean = String(vocabPath || DEFAULT_VOCAB_PATH).trim();
  const queryIdx = clean.indexOf("?");
  const base = queryIdx >= 0 ? clean.slice(0, queryIdx) : clean;
  const reviewName = /\.json$/i.test(base)
    ? base.replace(/\.json$/i, "_review.json")
    : `${base}_review.json`;
  const lastSlash = reviewName.lastIndexOf("/");
  if (lastSlash >= 0) {
    const dir = reviewName.slice(0, lastSlash);
    const fname = reviewName.slice(lastSlash + 1);
    return `${dir}/review/${fname}`;
  }
  return `./review/${reviewName}`;
}

export function extractFileName(filePath) {
  const clean = String(filePath || "").split("?")[0];
  const parts = clean.split("/");
  return parts[parts.length - 1] || "review.json";
}

export function extractJsonFilenamesFromHtml(htmlText, excludeNames = []) {
  const excluded = new Set(excludeNames.map((n) => n.toLowerCase()));
  const doc = new DOMParser().parseFromString(htmlText, "text/html");
  const names = new Set();
  doc.querySelectorAll("a[href]").forEach((a) => {
    const href = a.getAttribute("href") || "";
    const cleanHref = href.split("?")[0].split("#")[0];
    if (!cleanHref.toLowerCase().endsWith(".json")) return;
    const parts = cleanHref.split("/").filter(Boolean);
    const filename = parts[parts.length - 1];
    if (filename && !filename.startsWith(".") && !excluded.has(filename.toLowerCase())) {
      names.add(decodeURIComponent(filename));
    }
  });
  return Array.from(names);
}

function normalizeWord(raw, idx, packId) {
  const wordText = String(raw.word || raw.term || "").trim();
  const id = String(raw.id || `${packId || "pack"}_${idx + 1}_${wordText || "item"}`).trim();
  const collocations = Array.isArray(raw.collocations)
    ? raw.collocations
        .map((c) =>
          typeof c === "string"
            ? { phrase: c, meaning_zh: "" }
            : {
                phrase: String(c.phrase || c.en || "").trim(),
                meaning_zh: String(c.meaning_zh || c.zh || "").trim()
              }
        )
        .filter((c) => c.phrase)
    : [];

  const rawSentences = Array.isArray(raw.short_sentences)
    ? raw.short_sentences
    : Array.isArray(raw.sentences)
    ? raw.sentences
    : [];

  const short_sentences = rawSentences
    .map((s) =>
      typeof s === "string"
        ? { en: s, zh: "" }
        : { en: String(s.en || s.sentence || "").trim(), zh: String(s.zh || s.meaning_zh || "").trim() }
    )
    .filter((s) => s.en);

  return {
    id,
    pack_id: packId,
    word: wordText || `Word #${idx + 1}`,
    ipa: String(raw.ipa || raw.phonetic || "").trim(),
    pos: String(raw.pos || "").trim(),
    meaning_zh: String(raw.meaning_zh || raw.zh || "").trim(),
    collocations,
    short_sentences
  };
}

function parseVocabJson(state, jsonObj) {
  if (!jsonObj || typeof jsonObj !== "object") {
    throw new Error("JSON 根節點必須為物件或陣列。");
  }

  let packs = [];
  let activePackId = null;
  const schemaVersion = String(jsonObj.schema_version || "1.0.0");

  if (Array.isArray(jsonObj.packs)) {
    packs = jsonObj.packs.map((p, pIdx) => {
      const packId = String(p.pack_id || p.id || `pack_${pIdx + 1}`).trim();
      const packTitle = String(p.title || p.name || packId).trim();
      const rawWords = Array.isArray(p.words) ? p.words : Array.isArray(p.vocabulary) ? p.vocabulary : [];
      return {
        pack_id: packId,
        title: packTitle,
        description: String(p.description || "").trim(),
        level: String(p.level || "").trim(),
        words: rawWords.map((w, wIdx) => normalizeWord(w, wIdx, packId))
      };
    });
    activePackId =
      jsonObj.active_pack_id && packs.some((p) => p.pack_id === jsonObj.active_pack_id)
        ? jsonObj.active_pack_id
        : packs[0]
        ? packs[0].pack_id
        : null;
  } else if (Array.isArray(jsonObj.words) || Array.isArray(jsonObj.vocabulary)) {
    const rawWords = Array.isArray(jsonObj.words) ? jsonObj.words : jsonObj.vocabulary;
    const packId = String(jsonObj.pack_id || "imported_pack").trim();
    const packTitle = String(jsonObj.title || packId).trim();
    packs = [
      {
        pack_id: packId,
        title: packTitle,
        description: String(jsonObj.description || "").trim(),
        level: String(jsonObj.level || "").trim(),
        words: rawWords.map((w, wIdx) => normalizeWord(w, wIdx, packId))
      }
    ];
    activePackId = packId;
  } else if (Array.isArray(jsonObj)) {
    const packId = "array_pack";
    packs = [
      {
        pack_id: packId,
        title: packId,
        description: "",
        level: "",
        words: jsonObj.map((w, wIdx) => normalizeWord(w, wIdx, packId))
      }
    ];
    activePackId = packId;
  } else {
    throw new Error("找不到 packs、words/vocabulary 陣列或單字陣列。");
  }

  const validPacks = packs.filter((p) => p.words.length > 0);
  if (validPacks.length === 0) {
    throw new Error("JSON 檔案中沒有可用的單字項目。");
  }

  state.schemaVersion = schemaVersion;
  state.packs = validPacks;
  state.activePackId = validPacks.some((p) => p.pack_id === activePackId)
    ? activePackId
    : validPacks[0].pack_id;
}

function resolveFileUrl(baseUrl, entry) {
  const raw =
    typeof entry === "string"
      ? entry.trim()
      : String(entry?.path || entry?.url || entry?.file || entry?.filename || "").trim();
  if (!raw) return "";
  if (/^https?:\/\//i.test(raw) || raw.startsWith("./") || raw.startsWith("/")) {
    return raw;
  }
  return `${ensureTrailingSlash(baseUrl)}${raw}`;
}

export function downloadJson(filename, dataObj) {
  const blob = new Blob([JSON.stringify(dataObj, null, 2)], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function resolveVocabSourceConfig() {
  let baseUrl = "./";
  let manifestFile = "manifest.json";
  let explicitFiles = [];

  try {
    const cfg = await loadSiteConfig("./config.json", 3000);
    const vocabCfg = cfg?.vocab && typeof cfg.vocab === "object" ? cfg.vocab : cfg;
    if (vocabCfg && typeof vocabCfg === "object") {
      if (typeof vocabCfg.baseUrl === "string" && vocabCfg.baseUrl.trim()) {
        baseUrl = ensureTrailingSlash(vocabCfg.baseUrl.trim());
      } else if (typeof vocabCfg.folderName === "string" && vocabCfg.folderName.trim()) {
        baseUrl = ensureTrailingSlash(`./${vocabCfg.folderName.trim().replace(/^\/+|\/+$ /g, "")}`);
      }
      if (typeof vocabCfg.manifestFile === "string" && vocabCfg.manifestFile.trim()) {
        manifestFile = vocabCfg.manifestFile.trim();
      }
      if (Array.isArray(vocabCfg.files) && vocabCfg.files.length > 0) {
        explicitFiles = vocabCfg.files
          .map((f) => resolveFileUrl(baseUrl, f))
          .filter((p) => p && p.toLowerCase().endsWith(".json") && !p.toLowerCase().endsWith("_review.json"));
      }
    }
  } catch (_err) {
    // 若無 config.json，退回預設 ./ 設定
  }

  return { baseUrl, manifestFile, explicitFiles };
}

export async function discoverAndLoadVocab(state, {
  onStatus = () => {},
  onAfterLoad = () => {}
} = {}) {
  const { baseUrl, manifestFile, explicitFiles } = await resolveVocabSourceConfig();
  const excludes = [manifestFile, "config.json"].filter(Boolean);

  let resolvedFiles = [];

  if (explicitFiles.length > 0) {
    resolvedFiles = explicitFiles;
  } else {
    // 1. 嘗試讀取 baseUrl + manifestFile
    if (manifestFile) {
      try {
        const manRes = await fetchWithTimeout(`${ensureTrailingSlash(baseUrl)}${manifestFile}`, 2500);
        if (manRes.ok) {
          const manData = await manRes.json();
          const rawList = Array.isArray(manData)
            ? manData
            : Array.isArray(manData?.files)
            ? manData.files
            : Array.isArray(manData?.items)
            ? manData.items
            : [];
          resolvedFiles = rawList
            .map((entry) => resolveFileUrl(baseUrl, entry))
            .filter((p) => p && p.toLowerCase().endsWith(".json") && !p.toLowerCase().endsWith("_review.json"));
        }
      } catch (_err) {
        // 忽略 manifest 讀取失敗
      }
    }

    // 2. 若 manifest 無資料，嘗試掃描目錄 HTML 或退回預設清單
    if (resolvedFiles.length === 0) {
      const fallback = new Set(AVAILABLE_VOCAB_FILES.map((p) => resolveFileUrl(baseUrl, p)));
      try {
        const dirRes = await fetchWithTimeout(ensureTrailingSlash(baseUrl), 2000);
        if (dirRes.ok) {
          const text = await dirRes.text();
          extractJsonFilenamesFromHtml(text, excludes)
            .filter((n) => !n.toLowerCase().endsWith("_review.json"))
            .forEach((n) => fallback.add(`${ensureTrailingSlash(baseUrl)}${n}`));
        }
      } catch (_err) {}
      resolvedFiles = Array.from(fallback);
    }
  }

  state.availableVocabFiles = Array.from(new Set(resolvedFiles));
  state.vocabPath = state.availableVocabFiles[0] || DEFAULT_VOCAB_PATH;
  state.reviewPath = buildReviewFilePath(state.vocabPath);

  await loadVocabAndReview(state, state.vocabPath, {
    preserveExistingProgress: false,
    onStatus,
    onAfterLoad
  });
}

export async function loadVocabAndReview(state, targetVocabPath, {
  preserveExistingProgress = true,
  onStatus = () => {},
  onAfterLoad = () => {}
} = {}) {
  const nextVocabPath = String(targetVocabPath || DEFAULT_VOCAB_PATH).trim() || DEFAULT_VOCAB_PATH;
  state.vocabPath = nextVocabPath;
  state.reviewPath = buildReviewFilePath(nextVocabPath);

  if (!preserveExistingProgress) {
    state.progressByWordId = {};
    state.sessionEvents = [];
    state.hasNewRecords = false;
    state.newEventCount = 0;
  }

  try {
    const vocabRes = await fetchWithTimeout(state.vocabPath, 4000);
    if (!vocabRes.ok) {
      throw new Error(`讀取 ${state.vocabPath} 失敗 (HTTP ${vocabRes.status})`);
    }
    const vocabData = await vocabRes.json();
    parseVocabJson(state, vocabData);
  } catch (err) {
    state.reviewAutoStatusText = "單字檔未載入";
    onAfterLoad();
    onStatus(`無法載入 ${state.vocabPath}（${err.message}）。請確認檔案存在且透過 HTTP 伺服器開啟。`, true);
    return;
  }

  try {
    const reviewRes = await fetchWithTimeout(state.reviewPath, 4000);
    if (reviewRes.ok) {
      const reviewData = await reviewRes.json();
      const incomingMap =
        reviewData && reviewData.progress && typeof reviewData.progress === "object"
          ? reviewData.progress
          : reviewData && typeof reviewData === "object" && !Array.isArray(reviewData)
          ? reviewData
          : null;
      if (incomingMap) {
        state.progressByWordId = { ...incomingMap, ...state.progressByWordId };
      }
      if (Array.isArray(reviewData && reviewData.session_events) && state.sessionEvents.length === 0) {
        state.sessionEvents = reviewData.session_events;
      }
      state.reviewAutoStatusText = `已載入 ${extractFileName(state.reviewPath)}`;
    } else if (reviewRes.status === 404) {
      state.reviewAutoStatusText = `待建立 ${extractFileName(state.reviewPath)}`;
    } else {
      state.reviewAutoStatusText = `HTTP ${reviewRes.status}`;
    }
  } catch (_err) {
    state.reviewAutoStatusText = `待建立 ${extractFileName(state.reviewPath)}`;
  }

  onAfterLoad();
  const recordNotice = state.hasNewRecords
    ? `（目前尚有 ${state.newEventCount} 筆新學習紀錄已保留在網頁上，可隨時下載）`
    : "";
  onStatus(`已載入 ${state.vocabPath}；${state.reviewAutoStatusText}${recordNotice}`);
}
