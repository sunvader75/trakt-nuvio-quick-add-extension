/**
 * Normalizes noisy movie/series titles from download sites, torrent filenames,
 * streaming portals, and film databases into clean search titles + year + type.
 */

const LEADING_NOISE_RE =
  /^(?:descargar|bajar|ver|watch|download|stream|pel[ií]cula|pelicula|serie|online)\s+/i;

const SITE_SUFFIX_RE =
  /\s*(?:[•—|]|(?:\s+-\s+))\s*(?:letterboxd|imdb|the movie database(?:\s*\(tmdb\))?|tmdb|filmaffinity|trakt|justwatch|cuevana(?:\s*\d+)?|pelisplus|gnula|hdfull|dontorrent|mejortorrent|yts|1337x|rarbg|online gratis.*)$/i;

const TRAILING_ONLINE_RE = /\s+online\s+(?:gratis|hd|latino|castellano).*$/i;

const SERIES_MARKER_RE =
  /(?:\bS\d{1,2}E\d{1,2}\b|\bS\d{1,2}\b|\b(?:temporada|season|miniserie|miniseries)\s*\d*\b)/i;

const QUALITY_AND_RELEASE_TOKEN_RE =
  /\b(?:2160p|1080p|720p|480p|4k|uhd|hdr10?|dolby|dv|web-?dl|webrip|bluray|blu-ray|bdrip|brrip|hdrip|dvdrip|hdts|cam|ts|scr|x264|x265|h\.?264|h\.?265|hevc|av1|10bit|8bit|aac|ac3|eac3|dts(?:-hd)?(?:\.ma)?|atmos|truehd|5\.1|7\.1|dual|latino|castellano|espa[ñn]ol|ingles|english|subtitulado|sub|vose|multi|mega|mediafire|1fichier|torrent|magnet|rip)\b/i;

const PAREN_YEAR_RE = /\((19\d{2}|20\d{2})\)/;
const BARE_YEAR_RE = /\b(19\d{2}|20\d{2})\b/g;

function normalizeSceneSeparators(text) {
  const spaceCount = (text.match(/\s/g) || []).length;
  const dotCount = (text.match(/\./g) || []).length;
  const underscoreCount = (text.match(/_/g) || []).length;

  // Convert dot/underscore release names like "Oppenheimer.2023.2160p.UHD..."
  if (dotCount >= 2 && (spaceCount === 0 || dotCount > spaceCount)) {
    return text.replace(/[._]+/g, ' ');
  }
  if (underscoreCount >= 2 && spaceCount === 0) {
    return text.replace(/_+/g, ' ');
  }
  return text;
}

function stripTrailingNoise(text) {
  let cleaned = text.replace(/\[[^\]]*\]/g, ' ');
  cleaned = cleaned.replace(TRAILING_ONLINE_RE, '');

  const qualityMatch = cleaned.match(QUALITY_AND_RELEASE_TOKEN_RE);
  if (qualityMatch && typeof qualityMatch.index === 'number') {
    cleaned = cleaned.slice(0, qualityMatch.index);
  }

  return cleaned;
}

function extractYearAndTrim(text) {
  const parenMatch = text.match(PAREN_YEAR_RE);
  if (parenMatch) {
    const year = parenMatch[1];
    const withoutParen = text.replace(parenMatch[0], ' ');
    return { text: withoutParen, year };
  }

  const matches = [...text.matchAll(BARE_YEAR_RE)];
  if (matches.length === 0) {
    return { text, year: null };
  }

  // Prefer the last plausible release year when it sits near the end or after title words
  const candidate = matches[matches.length - 1];
  const year = candidate[1];
  if (typeof candidate.index === 'number' && candidate.index > 0) {
    const before = text.slice(0, candidate.index).trim();
    const after = text.slice(candidate.index + year.length).trim();
    if (before.length >= 2 && (after.length === 0 || /^[-–—•|(\[]/.test(after))) {
      return { text: before, year };
    }
  }

  return { text, year };
}

/**
 * Cleans a raw title string from a web page or torrent release name.
 * @param {string} rawText
 * @returns {{ title: string, year: string | null, type: 'movie' | 'series' }}
 */
export function cleanMediaTitle(rawText) {
  if (!rawText || typeof rawText !== 'string') {
    return { title: '', year: null, type: 'movie' };
  }

  let working = rawText.trim();
  if (!working) {
    return { title: '', year: null, type: 'movie' };
  }

  const isSeries = SERIES_MARKER_RE.test(working);
  working = normalizeSceneSeparators(working);
  working = working.replace(SITE_SUFFIX_RE, '');
  working = working.replace(LEADING_NOISE_RE, '');

  if (isSeries) {
    const seriesMatch = working.match(SERIES_MARKER_RE);
    if (seriesMatch && typeof seriesMatch.index === 'number' && seriesMatch.index > 0) {
      const yearHint = working.match(PAREN_YEAR_RE)?.[1] || null;
      const baseTitle = working
        .slice(0, seriesMatch.index)
        .replace(/[-–—:|(\[]+\s*$/, '')
        .trim();
      return {
        title: baseTitle.replace(/\s{2,}/g, ' '),
        year: yearHint,
        type: 'series'
      };
    }
  }

  working = stripTrailingNoise(working);
  const { text: withoutYear, year } = extractYearAndTrim(working);

  const finalTitle = withoutYear
    .replace(/\(\s*\)/g, ' ')
    .replace(/\s*[-–—:|]+\s*$/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  return {
    title: finalTitle,
    year,
    type: isSeries ? 'series' : 'movie'
  };
}
