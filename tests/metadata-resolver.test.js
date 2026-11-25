import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveMediaMetadata,
  searchMediaCandidates,
  toNuvioLibraryItem
} from '../src/shared/metadata-resolver.js';

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return payload;
    }
  };
}

test('resolveMediaMetadata looks up Cinemeta directly when imdbId is known', async () => {
  const calls = [];
  const mockFetch = async (url) => {
    calls.push(url);
    return jsonResponse({
      meta: {
        id: 'tt1375666',
        type: 'movie',
        name: 'Inception',
        poster: 'https://images.metahub.space/poster/medium/tt1375666/img',
        background: 'https://images.metahub.space/background/medium/tt1375666/img',
        description: 'A thief who steals corporate secrets...',
        releaseInfo: '2010',
        imdbRating: '8.8',
        genres: ['Action', 'Sci-Fi']
      }
    });
  };

  const resolved = await resolveMediaMetadata(
    { imdbId: 'tt1375666', type: 'movie', title: 'Inception' },
    {},
    mockFetch
  );

  assert.equal(calls[0], 'https://v3-cinemeta.strem.io/meta/movie/tt1375666.json');
  assert.equal(resolved.imdbId, 'tt1375666');
  assert.equal(resolved.name, 'Inception');
  assert.equal(resolved.releaseInfo, '2010');
  assert.equal(resolved.imdbRating, 8.8);
});

test('resolveMediaMetadata scores Cinemeta search candidates by title and year', async () => {
  const mockFetch = async (url) => {
    if (url.includes('/catalog/movie/top/search=')) {
      return jsonResponse({
        metas: [
          {
            id: 'tt0087182',
            type: 'movie',
            name: 'Dune',
            releaseInfo: '1984',
            poster: 'https://example.com/dune1984.jpg'
          },
          {
            id: 'tt1160419',
            type: 'movie',
            name: 'Dune',
            releaseInfo: '2021',
            poster: 'https://example.com/dune2021.jpg'
          }
        ]
      });
    }
    if (url.includes('/meta/movie/tt1160419.json')) {
      return jsonResponse({
        meta: {
          id: 'tt1160419',
          type: 'movie',
          name: 'Dune',
          releaseInfo: '2021',
          poster: 'https://example.com/dune2021.jpg',
          imdbRating: '8.0',
          genres: ['Adventure', 'Sci-Fi']
        }
      });
    }
    return jsonResponse({}, 404);
  };

  const resolved = await resolveMediaMetadata(
    { title: 'Dune', year: '2021', type: 'movie' },
    {},
    mockFetch
  );

  assert.equal(resolved.imdbId, 'tt1160419');
  assert.equal(resolved.releaseInfo, '2021');
});

test('resolveMediaMetadata uses optional TMDB key to translate tmdbId to imdbId', async () => {
  const mockFetch = async (url) => {
    if (url.includes('api.themoviedb.org/3/movie/550')) {
      return jsonResponse({
        id: 550,
        title: 'Fight Club',
        release_date: '1999-10-15',
        overview: 'An insomniac office worker...',
        poster_path: '/pB8BM7pdSp6B6Ih7QZ4DrQ3PmJK.jpg',
        backdrop_path: '/hZkgoQYus5vegHoetLkCJzb17zJ.jpg',
        vote_average: 8.4,
        genres: [{ id: 18, name: 'Drama' }],
        external_ids: { imdb_id: 'tt0137523' }
      });
    }
    return jsonResponse({}, 404);
  };

  const resolved = await resolveMediaMetadata(
    { tmdbId: '550', type: 'movie', title: 'Fight Club' },
    { tmdbApiKey: 'test-v3-key' },
    mockFetch
  );

  assert.equal(resolved.imdbId, 'tt0137523');
  assert.equal(resolved.tmdbId, '550');
  assert.equal(resolved.name, 'Fight Club');
  assert.equal(
    resolved.poster,
    'https://image.tmdb.org/t/p/w500/pB8BM7pdSp6B6Ih7QZ4DrQ3PmJK.jpg'
  );
});

test('toNuvioLibraryItem respects preferredIdFormat and formats Nuvio RPC fields', () => {
  const resolved = {
    imdbId: 'tt1375666',
    tmdbId: '27205',
    type: 'movie',
    name: 'Inception',
    poster: 'https://example.com/poster.jpg',
    background: 'https://example.com/bg.jpg',
    description: 'Dreams within dreams.',
    releaseInfo: '2010',
    imdbRating: 8.8,
    genres: ['Action', 'Sci-Fi']
  };

  const imdbItem = toNuvioLibraryItem(resolved, 'imdb', 1732531200000);
  assert.equal(imdbItem.content_id, 'tt1375666');
  assert.equal(imdbItem.content_type, 'movie');
  assert.equal(imdbItem.poster_shape, 'POSTER');
  assert.equal(imdbItem.imdb_rating, 8.8);
  assert.equal(imdbItem.added_at, 1732531200000);

  const tmdbItem = toNuvioLibraryItem(resolved, 'tmdb', 1732531200000);
  assert.equal(tmdbItem.content_id, 'tmdb:27205');
});

test('searchMediaCandidates returns deduplicated ranked candidates from Cinemeta', async () => {
  const mockFetch = async (url) => {
    if (url.includes('/catalog/movie/')) {
      return jsonResponse({
        metas: [
          { id: 'tt0133093', type: 'movie', name: 'The Matrix', releaseInfo: '1999' }
        ]
      });
    }
    if (url.includes('/catalog/series/')) {
      return jsonResponse({
        metas: []
      });
    }
    return jsonResponse({ metas: [] });
  };

  const results = await searchMediaCandidates('The Matrix', {}, mockFetch);
  assert.equal(results.length, 1);
  assert.equal(results[0].imdbId, 'tt0133093');
  assert.equal(results[0].name, 'The Matrix');
});

test('resolveMediaMetadata accepts name/releaseInfo input and falls back to Trakt search for localized titles', async () => {
  const mockFetch = async (url, options) => {
    if (url.includes('v3-cinemeta.strem.io/catalog/')) {
      return jsonResponse({ metas: [] });
    }
    if (url.includes('api.trakt.tv/search/movie')) {
      assert.equal(options.headers['trakt-api-key'], 'trakt-key-1');
      return jsonResponse([
        {
          type: 'movie',
          score: 42,
          movie: {
            title: 'The Substance',
            year: 2024,
            ids: {
              trakt: 912345,
              slug: 'the-substance-2024',
              imdb: 'tt17526714',
              tmdb: 933260
            }
          }
        }
      ]);
    }
    if (url.includes('v3-cinemeta.strem.io/meta/movie/tt17526714.json')) {
      return jsonResponse({
        meta: {
          id: 'tt17526714',
          type: 'movie',
          name: 'The Substance',
          releaseInfo: '2024',
          poster: 'https://images.metahub.space/poster/medium/tt17526714/img'
        }
      });
    }
    return jsonResponse({}, 404);
  };

  // Simulates receiving an object with .name / .releaseInfo (instead of .title / .year)
  const resolved = await resolveMediaMetadata(
    { name: 'La sustancia', releaseInfo: '2024', type: 'movie' },
    { traktClientId: 'trakt-key-1' },
    mockFetch
  );

  assert.equal(resolved.imdbId, 'tt17526714');
  assert.equal(resolved.tmdbId, '933260');
  assert.equal(resolved.traktId, '912345');
  assert.equal(resolved.name, 'The Substance');
});
