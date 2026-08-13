export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function chunkArray(items, size) {
  const list = Array.isArray(items) ? items : [];
  const chunkSize = Math.max(1, Number(size) || 1);
  const chunks = [];
  for (let i = 0; i < list.length; i += chunkSize) {
    chunks.push(list.slice(i, i + chunkSize));
  }
  return chunks;
}

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

