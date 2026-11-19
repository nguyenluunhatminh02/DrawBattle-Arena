import { containsProfanity, censorProfanity } from './profanity';

describe('profanity', () => {
  describe('containsProfanity', () => {
    it('detects English profanity', () => {
      expect(containsProfanity('fuck this')).toBe(true);
      expect(containsProfanity('what the hell')).toBe(false);
    });
    it('detects Vietnamese profanity', () => {
      expect(containsProfanity('đụ má')).toBe(true);
      expect(containsProfanity('dm vl')).toBe(true);
    });
    it('is case insensitive', () => {
      expect(containsProfanity('FUCK')).toBe(true);
      expect(containsProfanity('Fuck')).toBe(true);
    });
    it('ignores diacritics for Vietnamese', () => {
      expect(containsProfanity('đụ má')).toBe(true);
    });
    it('allows clean nicknames', () => {
      expect(containsProfanity('Minh')).toBe(false);
      expect(containsProfanity('LanAnh')).toBe(false);
      expect(containsProfanity('GameMaster42')).toBe(false);
    });
    it('detects embedded profanity', () => {
      expect(containsProfanity('myfuckingname')).toBe(true);
    });
    it('allows legitimate Vietnamese seed words (regression)', () => {
      expect(containsProfanity('con chó')).toBe(false);
      expect(containsProfanity('chợ')).toBe(false);
      expect(containsProfanity('đi bộ')).toBe(false);
      expect(containsProfanity('con chim cánh cụt')).toBe(false);
      expect(containsProfanity('đũa')).toBe(false);
      expect(containsProfanity('đám mây')).toBe(false);
    });
  });

  describe('censorProfanity', () => {
    it('replaces profane words with asterisks', () => {
      expect(censorProfanity('what the fuck')).toBe('what the ****');
    });
  });
});
