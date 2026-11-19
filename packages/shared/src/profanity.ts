const PROFANITY_LIST = [
  'fuck', 'shit', 'ass', 'bitch', 'damn', 'dick', 'pussy', 'cunt',
  'nigger', 'nigga', 'faggot', 'retard', 'whore', 'slut',
  'đụ', 'địt', 'đéo', 'lồn', 'cặc', 'đĩ', 'chó', 'má',
  'fuckface', 'asshole', 'bastard'
];

export function containsProfanity(text: string): boolean {
  const lower = text.toLowerCase();
  for (const word of PROFANITY_LIST) {
    if (lower.includes(word)) {
      return true;
    }
  }
  return false;
}
