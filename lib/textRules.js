export function looksLikeReplyText(text = "") {
  // re: から始まる返信表現のみ監視
  return /\bre:/i.test((text || "").trim());
}
