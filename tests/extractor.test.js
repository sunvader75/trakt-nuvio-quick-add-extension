import test from 'node:test';
import assert from 'node:assert/strict';
import { extractMediaFromDocument } from '../src/shared/extractor.js';

function createMockElement({
  tagName = 'DIV',
  textContent = '',
  attrs = {},
  matchesSelectors = []
} = {}) {
  return {
    tagName: tagName.toUpperCase(),
    textContent,
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(attrs, name)
        ? attrs[name]
        : null;
    },
    matches(selector) {
      return matchesSelectors.includes(selector);
    },
    closest() {
      return null;
    }
  };
}

function createMockDoc({ title = '', bodyText = '', selectorMap = {} } = {}) {
  return {
    title,
    body: { textContent: bodyText },
    querySelector(selector) {
      const list = selectorMap[selector] || [];
      return list[0] || null;
    },
    querySelectorAll(selector) {
      return selectorMap[selector] || [];
    }
  };
}

test('extractMediaFromDocument parses Letterboxd film page with IMDb & TMDB links', () => {
  const doc = createMockDoc({
    title: 'Dune: Part Two (2024) • Letterboxd',
    bodyText: 'Dune: Part Two Directed by Denis Villeneuve',
    selectorMap: {
      'h1.headline-1, h1.filmtitle, section#featured-film-header h1': [
        createMockElement({ tagName: 'h1', textContent: 'Dune: Part Two' })
      ],
      '.releaseyear a, span.releasedate a': [
        createMockElement({ tagName: 'a', textContent: '2024' })
      ],
      'meta[property="og:title"]': [
        createMockElement({
          tagName: 'meta',
          attrs: { content: 'Dune: Part Two (2024)' }
        })
      ],
      'meta[property="og:image"]': [
        createMockElement({
          tagName: 'meta',
          attrs: { content: 'https://a.ltrbxd.com/poster.jpg' }
        })
      ],
      'a[href*="imdb.com/title/tt"]': [
        createMockElement({
          tagName: 'a',
          attrs: { href: 'https://www.imdb.com/title/tt15239678/maindetails' }
        })
      ],
      'a[href*="themoviedb.org/movie/"], a[href*="themoviedb.org/tv/"]': [
        createMockElement({
          tagName: 'a',
          attrs: { href: 'https://www.themoviedb.org/movie/693134/' }
        })
      ]
    }
  });

  const result = extractMediaFromDocument(
    doc,
    'https://letterboxd.com/film/dune-part-two/'
  );

  assert.equal(result.isMoviePage, true);
  assert.equal(result.source, 'letterboxd');
  assert.equal(result.imdbId, 'tt15239678');
  assert.equal(result.tmdbId, '693134');
  assert.equal(result.type, 'movie');
  assert.equal(result.title, 'Dune: Part Two');
  assert.equal(result.year, '2024');
  assert.equal(result.poster, 'https://a.ltrbxd.com/poster.jpg');
});

test('extractMediaFromDocument extracts IMDb ID from IMDb URL and JSON-LD', () => {
  const jsonLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'Movie',
    name: 'Inception',
    datePublished: '2010-07-16',
    image: 'https://m.media-amazon.com/inception.jpg'
  });

  const doc = createMockDoc({
    title: 'Inception (2010) - IMDb',
    selectorMap: {
      'script[type="application/ld+json"]': [
        createMockElement({ tagName: 'script', textContent: jsonLd })
      ]
    }
  });

  const result = extractMediaFromDocument(
    doc,
    'https://www.imdb.com/title/tt1375666/?ref_=nv_sr_srsg_0'
  );

  assert.equal(result.isMoviePage, true);
  assert.equal(result.source, 'imdb');
  assert.equal(result.imdbId, 'tt1375666');
  assert.equal(result.type, 'movie');
  assert.equal(result.title, 'Inception');
  assert.equal(result.year, '2010');
});

test('extractMediaFromDocument detects download page via outbound IMDb link and dirty H1', () => {
  const doc = createMockDoc({
    title: 'Descargar Interstellar (2014) 1080p Dual Latino - MiWebDDL',
    bodyText: 'Sinopsis: Un grupo de exploradores... Calidad 1080p BluRay',
    selectorMap: {
      h1: [
        createMockElement({
          tagName: 'h1',
          textContent: 'Descargar Interstellar (2014) [1080p] [Latino-Ingles]'
        })
      ],
      'a[href*="imdb.com/title/tt"]': [
        createMockElement({
          tagName: 'a',
          attrs: { href: 'https://www.imdb.com/title/tt0816692/' }
        })
      ]
    }
  });

  const result = extractMediaFromDocument(
    doc,
    'https://miwebddl.example.com/pelicula/interstellar-2014/'
  );

  assert.equal(result.isMoviePage, true);
  assert.equal(result.imdbId, 'tt0816692');
  assert.equal(result.title, 'Interstellar');
  assert.equal(result.year, '2014');
  assert.equal(result.type, 'movie');
});

test('extractMediaFromDocument detects download page without IMDb link when title+year+movie indicators exist', () => {
  const doc = createMockDoc({
    title: 'Oppenheimer (2023) Torrent 4K HDR',
    bodyText: 'Synopsis: The story of American scientist... BluRay 2160p Magnet Download',
    selectorMap: {
      h1: [
        createMockElement({
          tagName: 'h1',
          textContent: 'Oppenheimer.2023.2160p.UHD.BluRay.x265'
        })
      ],
      'meta[property="og:image"]': [
        createMockElement({
          tagName: 'meta',
          attrs: { content: 'https://cdn.example.com/opp.jpg' }
        })
      ]
    }
  });

  const result = extractMediaFromDocument(
    doc,
    'https://tracker.example.com/torrent/12345'
  );

  assert.equal(result.isMoviePage, true);
  assert.equal(result.imdbId, null);
  assert.equal(result.title, 'Oppenheimer');
  assert.equal(result.year, '2023');
});

test('extractMediaFromDocument avoids false positives on generic non-movie web pages', () => {
  const doc = createMockDoc({
    title: 'Inbox (4) - user@example.com - Gmail',
    bodyText: 'Compose Primary Promotions Social',
    selectorMap: {
      h1: [createMockElement({ tagName: 'h1', textContent: 'Inbox' })]
    }
  });

  const result = extractMediaFromDocument(doc, 'https://mail.google.com/mail/u/0/');
  assert.equal(result.isMoviePage, false);
  assert.equal(result.title, 'Inbox');
});

test('extractMediaFromDocument parses TMDB movie and TV URLs', () => {
  const doc = createMockDoc({
    title: 'Fight Club (1999) — The Movie Database (TMDB)',
    selectorMap: {
      'meta[property="og:title"]': [
        createMockElement({
          tagName: 'meta',
          attrs: { content: 'Fight Club' }
        })
      ]
    }
  });

  const result = extractMediaFromDocument(
    doc,
    'https://www.themoviedb.org/movie/550-fight-club'
  );
  assert.equal(result.isMoviePage, true);
  assert.equal(result.source, 'tmdb');
  assert.equal(result.tmdbId, '550');
  assert.equal(result.type, 'movie');
  assert.equal(result.title, 'Fight Club');
});

test('extractMediaFromDocument detects movie when year lives in separate .year element', () => {
  const doc = createMockDoc({
    title: 'Alien: Romulus Online HD - PelisSite',
    bodyText: 'Sinopsis: Un grupo de jóvenes colonizadores... Reparto Director 1080p',
    selectorMap: {
      h1: [createMockElement({ tagName: 'h1', textContent: 'Alien: Romulus' })],
      '.year, [class*="year"], time': [
        createMockElement({ tagName: 'span', textContent: '2024' })
      ]
    }
  });

  const result = extractMediaFromDocument(
    doc,
    'https://pelissite.example.com/ver/alien-romulus-2024/'
  );
  assert.equal(result.isMoviePage, true);
  assert.equal(result.title, 'Alien: Romulus');
  assert.equal(result.year, '2024');
});
