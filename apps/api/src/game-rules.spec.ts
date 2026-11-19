import {
  calculateGuesserScore,
  calculateDrawerScore,
  normalizeGuess,
  validateGuess,
  generateRoomCode,
  validateStrokeCoordinates,
  generateHint,
} from '@drawbattle/shared';

describe('game-rules', () => {
  describe('calculateGuesserScore', () => {
    it('gives max base+bonus when guessed instantly', () => {
      expect(calculateGuesserScore(60, 60, true, false)).toBe(160);
    });
    it('decays with remaining time', () => {
      expect(calculateGuesserScore(60, 30, false, false)).toBe(110);
    });
    it('caps at 160', () => {
      expect(calculateGuesserScore(60, 600, true, false)).toBe(160);
    });
    it('drops first-correct bonus when not first', () => {
      expect(calculateGuesserScore(60, 60, false, false)).toBe(160);
      expect(calculateGuesserScore(60, 0, false, false)).toBe(60);
    });
  });

  describe('calculateDrawerScore', () => {
    it('awards 20 per correct guesser', () => {
      expect(calculateDrawerScore(1)).toBe(20);
      expect(calculateDrawerScore(3)).toBe(60);
    });
    it('caps at 100', () => {
      expect(calculateDrawerScore(10)).toBe(100);
    });
  });

  describe('normalizeGuess', () => {
    it('lowercases, trims and collapses whitespace', () => {
      expect(normalizeGuess('  Con   MÈO ')).toBe('con mèo');
    });
  });

  describe('validateGuess', () => {
    it('matches canonical ignoring case/diacritics placement', () => {
      expect(validateGuess('CON MÈO', 'con mèo', [])).toBe(true);
    });
    it('matches synonyms', () => {
      expect(validateGuess('mèo', 'con mèo', ['mèo', 'puppy'])).toBe(true);
    });
    it('rejects wrong answer', () => {
      expect(validateGuess('chó', 'con mèo', ['mèo'])).toBe(false);
    });
  });

  describe('generateRoomCode', () => {
    it('produces 6-char code from safe alphabet', () => {
      const code = generateRoomCode();
      expect(code).toHaveLength(6);
      expect(code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/);
    });
    it('is collision-resistant across samples', () => {
      const set = new Set(Array.from({ length: 200 }, () => generateRoomCode()));
      expect(set.size).toBeGreaterThan(180);
    });
  });

  describe('validateStrokeCoordinates', () => {
    it('accepts normalized points', () => {
      expect(validateStrokeCoordinates([{ x: 0, y: 0 }, { x: 1, y: 0.5 }])).toBe(true);
    });
    it('rejects out-of-range and non-finite', () => {
      expect(validateStrokeCoordinates([{ x: 1.5, y: 0 }])).toBe(false);
      expect(validateStrokeCoordinates([{ x: NaN, y: 0 }])).toBe(false);
    });
  });

  describe('generateHint', () => {
    it('first phase masks all letters', () => {
      expect(generateHint('con mèo', 'first')).toBe('___ ___');
    });
    it('second phase reveals at least one letter', () => {
      const h = generateHint('con mèo', 'second');
      expect(h.replace(/[_ ]/g, '').length).toBeGreaterThan(0);
      expect(h).toHaveLength('con mèo'.length);
    });
  });
});