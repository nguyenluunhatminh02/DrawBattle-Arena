const EN_PROFANE = [
  'fuck', 'shit', 'bitch', 'dick', 'cunt', 'nigger', 'nigga',
  'faggot', 'retard', 'whore', 'slut', 'bastard', 'piss', 'damn', 'ass',
];

const VI_PROFANE = [
  'đụ', 'đéo', 'địt', 'lồn', 'cặc', 'đĩ', 'cứt',
  'đm', 'dcm', 'vkl', 'vl', 'vãi',
];

const EN_SET = new Set(EN_PROFANE);
const VI_SET = new Set(VI_PROFANE);

function normalizeVi(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFC')
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripDiacritics(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function containsProfanity(text: string): boolean {
  const viWords = normalizeVi(text).split(' ').filter(Boolean);
  for (const w of viWords) {
    if (VI_SET.has(w)) return true;
  }

  const enWords = stripDiacritics(text).split(' ').filter(Boolean);
  for (const w of enWords) {
    if (EN_SET.has(w)) return true;
  }
  const joined = enWords.join('');
  for (const p of EN_PROFANE) {
    if (p.length >= 4 && joined.includes(p)) return true;
  }
  return false;
}

export function censorProfanity(text: string): string {
  let result = text;
  for (const word of [...VI_PROFANE, ...EN_PROFANE]) {
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'giu');
    result = result.replace(re, m => '*'.repeat(m.length));
  }
  for (const word of EN_PROFANE) {
    if (word.length >= 4) {
      result = result.replace(new RegExp(word, 'gi'), m => '*'.repeat(m.length));
    }
  }
  return result;
}
