export function speakText(text, rate = 1.0, onError = null) {
  if (!text || !("speechSynthesis" in window)) {
    if (typeof onError === "function") {
      onError("目前瀏覽器不支援語音合成 (Web Speech API)。", true);
    }
    return;
  }
  window.speechSynthesis.cancel();
  const utter = new SpeechSynthesisUtterance(text);
  utter.lang = "en-US";
  utter.rate = rate;
  window.speechSynthesis.speak(utter);
}
