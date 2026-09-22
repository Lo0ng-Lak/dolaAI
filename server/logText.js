const CLOSED = /target closed|has been closed|browser has been closed|context or browser|execution context was destroyed|protocol error \(session closed\)|net::ERR_ABORTED/i;

export function isClosedNoise(message) {
  return CLOSED.test(String(message || ""));
}

export function sanitizeLog(level, message) {
  const text = String(message || "").replace(/\s+/g, " ").trim();
  if (!text) return null;
  if (CLOSED.test(text)) {
    return { level: "info", message: "Đã tắt Chrome." };
  }
  return {
    level,
    message: text
      .replace(/[A-Za-z]:\\[^\s]+\\profiles\\[^\s]+/g, "profile nội bộ")
      .replace(/[A-Za-z]:\\Users\\[^\s]+\\Desktop\\Sedan\\[^\s]+/g, "thư mục app"),
  };
}
