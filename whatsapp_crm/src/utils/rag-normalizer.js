const DEFAULT_STOP_WORDS = new Set([
    'это', 'как', 'так', 'и', 'в', 'над', 'к', 'до', 'не', 'на', 'но',
    'со', 'для', 'из', 'за', 'от', 'о', 'по', 'с', 'а', 'бы', 'же',
    'он', 'она', 'они', 'мы', 'вы', 'что', 'кто', 'где', 'когда',
    'тут', 'там', 'тоже', 'уже', 'ещё', 'может', 'будет', 'был',
    'были', 'быть', 'вот', 'еще', 'его', 'ей', 'если', 'есть',
    'им', 'их', 'какой', 'который', 'нибудь', 'одна', 'одно',
    'одной', 'одного', 'только', 'этот', 'этих', 'эти', 'чем',
    'чему', 'через', 'чтобы', 'чуть', 'я', 'ты', 'меня', 'мне',
    'мной', 'тебя', 'тебе', 'себя', 'себе', 'собой', 'нас', 'нам',
    'вас', 'вам', 'ними', 'нее', 'ней', 'ним', 'них', 'ну', 'ли',
    'ведь', 'даже', 'лишь', 'пожалуйста', 'очень', 'много', 'могу',
    'нужно', 'надо', 'без', 'после', 'перед', 'между', 'под', 'над'
]);

let stemmer = null;
try {
    const natural = require('natural');
    stemmer = natural.PorterStemmerRu;
} catch (error) {
    stemmer = null;
}

function normalizeTokens(text) {
    if (!text) return [];

    const tokens = text.toLowerCase()
        .replace(/[-_/\\]+/g, ' ')
        .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
        .split(/\s+/)
        .map((token) => token.trim())
        .filter(Boolean)
        .filter((token) => token.length > 2)
        .filter((token) => !DEFAULT_STOP_WORDS.has(token));

    if (!stemmer) {
        return tokens;
    }

    return tokens.map((token) => {
        try {
            return stemmer.stem(token);
        } catch (error) {
            return token;
        }
    });
}

function normalizeSearchText(text) {
    return normalizeTokens(text).join(' ');
}

function buildFtsQueries(text) {
    const tokens = normalizeTokens(text);
    if (tokens.length === 0) {
        return { tokens, primary: '', fallback: '' };
    }

    const escaped = tokens.map((token) => token.replace(/"/g, ''));
    const primary = escaped.map((token) => `${token}*`).join(' AND ');
    const fallback = escaped.map((token) => `${token}*`).join(' OR ');

    return { tokens: escaped, primary, fallback };
}

module.exports = {
    DEFAULT_STOP_WORDS,
    normalizeTokens,
    normalizeSearchText,
    buildFtsQueries,
    hasStemmer: !!stemmer
};
