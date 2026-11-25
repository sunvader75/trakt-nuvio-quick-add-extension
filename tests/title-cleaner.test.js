import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanMediaTitle } from '../src/shared/title-cleaner.js';

test('cleanMediaTitle cleans Spanish DDL title with brackets and hosts', () => {
  const result = cleanMediaTitle(
    'Descargar Dune: Parte Dos (2024) [1080p] [Latino-Ingles] Mega Mediafire'
  );
  assert.equal(result.title, 'Dune: Parte Dos');
  assert.equal(result.year, '2024');
  assert.equal(result.type, 'movie');
});

test('cleanMediaTitle cleans dot-separated scene release torrent filename', () => {
  const result = cleanMediaTitle(
    'Oppenheimer.2023.2160p.UHD.BluRay.x265.10bit.HDR.DTS-HD.MA.5.1-SWTYBLZ'
  );
  assert.equal(result.title, 'Oppenheimer');
  assert.equal(result.year, '2023');
  assert.equal(result.type, 'movie');
});

test('cleanMediaTitle strips streaming site prefixes and suffixes', () => {
  const result = cleanMediaTitle(
    'Ver Alien: Romulus (2024) Online Gratis HD - Cuevana 3'
  );
  assert.equal(result.title, 'Alien: Romulus');
  assert.equal(result.year, '2024');
  assert.equal(result.type, 'movie');
});

test('cleanMediaTitle strips Letterboxd, IMDb, and TMDB site suffixes', () => {
  assert.deepEqual(cleanMediaTitle('Inception (2010) • Letterboxd'), {
    title: 'Inception',
    year: '2010',
    type: 'movie'
  });
  assert.deepEqual(cleanMediaTitle('The Matrix (1999) - IMDb'), {
    title: 'The Matrix',
    year: '1999',
    type: 'movie'
  });
  assert.deepEqual(
    cleanMediaTitle('Parasite (2019) — The Movie Database (TMDB)'),
    {
      title: 'Parasite',
      year: '2019',
      type: 'movie'
    }
  );
});

test('cleanMediaTitle strips Spanish quality and audio tags without parentheses', () => {
  const result = cleanMediaTitle(
    'Nosferatu 2024 BluRay Rip Castellano AC3 5.1'
  );
  assert.equal(result.title, 'Nosferatu');
  assert.equal(result.year, '2024');
  assert.equal(result.type, 'movie');
});

test('cleanMediaTitle detects TV series from season/episode markers', () => {
  const result = cleanMediaTitle('Severance S02E01 1080p WEB-DL x265');
  assert.equal(result.title, 'Severance');
  assert.equal(result.type, 'series');

  const spanishSeries = cleanMediaTitle('The Bear Temporada 3 (2024) HD');
  assert.equal(spanishSeries.title, 'The Bear');
  assert.equal(spanishSeries.year, '2024');
  assert.equal(spanishSeries.type, 'series');
});

test('cleanMediaTitle handles empty or whitespace-only input safely', () => {
  assert.deepEqual(cleanMediaTitle('   '), {
    title: '',
    year: null,
    type: 'movie'
  });
});
