import { parseScript } from "../app/utils/scriptUtils";

describe('parseTranscript', () => {

  describe('parseScript', () => {

    it('should return empty', () => {
      expect(parseScript('')).toStrictEqual([]);
    });

    it('should parse actor', () => {
      expect(parseScript(`
      Deliar:
      Hi there.

      Second message.
      Third message.

      (the audience applauds)

      Gian (gleeful):
      Fourth message.
      `)).toStrictEqual([
        {role: 'assistant', text: '(Deliar) Hi there.'},
        {role: 'assistant', text: '(Deliar) Second message.'},
        {role: 'assistant', text: '(Deliar) Third message.'},
        {role: 'user', text: '(the audience applauds)'},
        {role: 'user', text: '(Gian) [gleeful] Fourth message.'},
      ]);
    });

  });
});
