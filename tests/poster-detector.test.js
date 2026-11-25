import test from 'node:test';
import assert from 'node:assert/strict';
import { findMoviePosterCards } from '../src/shared/poster-detector.js';

function createNode({
  tagName = 'DIV',
  attrs = {},
  textContent = '',
  rect = { width: 0, height: 0 },
  children = [],
  parentElement = null,
  matchesList = []
} = {}) {
  const node = {
    tagName: tagName.toUpperCase(),
    textContent,
    parentElement,
    children,
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(attrs, name)
        ? attrs[name]
        : null;
    },
    getBoundingClientRect() {
      return rect;
    },
    matches(selector) {
      return matchesList.includes(selector);
    },
    querySelector(selector) {
      for (const child of children) {
        if (child.matches(selector)) return child;
        const nested = child.querySelector(selector);
        if (nested) return nested;
      }
      return null;
    },
    closest(selector) {
      let cur = node;
      while (cur) {
        if (cur.matches(selector)) return cur;
        cur = cur.parentElement;
      }
      return null;
    }
  };
  for (const child of children) {
    child.parentElement = node;
  }
  return node;
}

function createMockPosterDoc(elementsBySelector) {
  return {
    querySelectorAll(selector) {
      return elementsBySelector[selector] || [];
    }
  };
}

test('findMoviePosterCards detects Letterboxd poster cards with slug/title', () => {
  const img = createNode({
    tagName: 'IMG',
    attrs: { src: 'https://a.ltrbxd.com/dune.jpg', alt: 'Dune: Part Two' },
    rect: { width: 150, height: 225 },
    matchesList: ['img']
  });
  const link = createNode({
    tagName: 'A',
    attrs: { href: '/film/dune-part-two/', 'data-original-title': 'Dune: Part Two (2024)' },
    matchesList: ['a']
  });
  const posterDiv = createNode({
    tagName: 'DIV',
    attrs: {
      'data-item-slug': 'dune-part-two',
      'data-item-name': 'Dune: Part Two (2024)'
    },
    rect: { width: 150, height: 225 },
    children: [img, link],
    matchesList: ['.film-poster, [data-film-slug], [data-item-slug]']
  });

  const doc = createMockPosterDoc({
    '.film-poster, [data-film-slug], [data-item-slug]': [posterDiv],
    'img': [img]
  });

  const cards = findMoviePosterCards(doc, 'https://letterboxd.com/films/');
  assert.equal(cards.length, 1);
  assert.equal(cards[0].title, 'Dune: Part Two');
  assert.equal(cards[0].year, '2024');
  assert.equal(cards[0].poster, 'https://a.ltrbxd.com/dune.jpg');
});

test('findMoviePosterCards detects IMDb and TMDB poster cards', () => {
  const imdbImg = createNode({
    tagName: 'IMG',
    attrs: { src: 'https://m.media-amazon.com/inc.jpg', alt: 'Inception' },
    rect: { width: 140, height: 210 },
    matchesList: ['img']
  });
  const imdbCard = createNode({
    tagName: 'DIV',
    rect: { width: 140, height: 210 },
    children: [
      createNode({
        tagName: 'A',
        attrs: { href: 'https://www.imdb.com/title/tt1375666/' },
        children: [imdbImg],
        matchesList: ['a', 'a[href*="/title/tt"]']
      })
    ],
    matchesList: ['.ipc-poster-card, .lister-item, .ipc-metadata-list-summary-item']
  });

  const tmdbImg = createNode({
    tagName: 'IMG',
    attrs: { src: 'https://image.tmdb.org/t/p/w300/fc.jpg', alt: 'Fight Club' },
    rect: { width: 150, height: 225 },
    matchesList: ['img']
  });
  const tmdbCard = createNode({
    tagName: 'DIV',
    rect: { width: 150, height: 225 },
    children: [
      createNode({
        tagName: 'A',
        attrs: { href: 'https://www.themoviedb.org/movie/550-fight-club', title: 'Fight Club' },
        children: [tmdbImg],
        matchesList: ['a', 'a[href*="/movie/"]']
      })
    ],
    matchesList: ['.card, .poster']
  });

  const doc = createMockPosterDoc({
    'img': [imdbImg, tmdbImg]
  });

  const cards = findMoviePosterCards(doc, 'https://www.themoviedb.org/movie');
  assert.equal(cards.length, 2);
  assert.equal(cards[0].imdbId, 'tt1375666');
  assert.equal(cards[1].tmdbId, '550');
  assert.equal(cards[1].title, 'Fight Club');
});

test('findMoviePosterCards detects generic download/streaming 2:3 posters and ignores landscape/tiny images', () => {
  const posterImg = createNode({
    tagName: 'IMG',
    attrs: {
      src: 'https://site.example.com/posters/nosferatu.jpg',
      alt: 'Descargar Nosferatu (2024) 1080p Latino'
    },
    rect: { width: 180, height: 270 },
    matchesList: ['img']
  });
  const posterAnchor = createNode({
    tagName: 'A',
    attrs: { href: 'https://site.example.com/pelicula/nosferatu-2024/' },
    children: [posterImg],
    matchesList: ['a']
  });
  const movieCard = createNode({
    tagName: 'ARTICLE',
    textContent: 'Nosferatu (2024) 1080p WEB-DL',
    rect: { width: 180, height: 310 },
    children: [posterAnchor],
    matchesList: ['article']
  });

  const landscapeImg = createNode({
    tagName: 'IMG',
    attrs: { src: 'https://site.example.com/banner.jpg', alt: 'Screenshot 1080p' },
    rect: { width: 320, height: 180 },
    matchesList: ['img']
  });
  const tinyIcon = createNode({
    tagName: 'IMG',
    attrs: { src: 'https://site.example.com/star.png', alt: 'Rating' },
    rect: { width: 24, height: 24 },
    matchesList: ['img']
  });

  const doc = createMockPosterDoc({
    'img': [posterImg, landscapeImg, tinyIcon]
  });

  const cards = findMoviePosterCards(doc, 'https://site.example.com/peliculas/');
  assert.equal(cards.length, 1);
  assert.equal(cards[0].title, 'Nosferatu');
  assert.equal(cards[0].year, '2024');
  assert.equal(cards[0].element, movieCard || posterAnchor);
});

test('findMoviePosterCards ignores placeholder alt="Poster" and strips injected + Trakt text', () => {
  const posterImg = createNode({
    tagName: 'IMG',
    attrs: {
      src: 'https://site.example.com/img/gladiator.jpg',
      alt: 'Poster'
    },
    rect: { width: 160, height: 240 },
    matchesList: ['img']
  });
  const link = createNode({
    tagName: 'A',
    attrs: { href: 'https://site.example.com/pelicula/gladiator-ii-2024/' },
    children: [posterImg],
    matchesList: ['a']
  });
  const cardEl = createNode({
    tagName: 'ARTICLE',
    textContent: 'Gladiator II (2024) + Trakt',
    rect: { width: 160, height: 280 },
    children: [link],
    matchesList: ['article']
  });

  const doc = createMockPosterDoc({ img: [posterImg] });
  const cards = findMoviePosterCards(doc, 'https://site.example.com/');
  assert.equal(cards.length, 1);
  assert.equal(cards[0].title, 'Gladiator II');
  assert.equal(cards[0].year, '2024');
});
