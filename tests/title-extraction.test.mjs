import assert from "node:assert/strict";
import test from "node:test";
import { renderAioStreamsFormat } from "../dist/providers/custom-formatter.js";

const extract = (title) => {
  const stream = { title };
  renderAioStreamsFormat("{stream.title}", stream, "test");
  return { title: stream.title, year: stream.year };
};

test("titles are cut at provider delimiters and stray brackets", () => {
  assert.equal(extract("A Dog's Perfect Christmas - HubCloud - FSL [").title, "A Dog's Perfect Christmas");
  assert.equal(extract("A Dog's Perfect Christmas ( (2026)").title, "A Dog's Perfect Christmas");
  assert.equal(extract("Ngôi Nhà Về Đêm | Phụ Đề (2021)").title, "Ngôi Nhà Về Đêm");
  assert.equal(extract("Movie Name • VidLink • 2021").title, "Movie Name");
  assert.equal(extract("[HubCloud] Some Movie ~ 2021 ~ 720p").title, "Some Movie");
});

test("year is parsed out of the title, including leading and in-title years", () => {
  assert.deepEqual(extract("Twas The Night (2021)"), { title: "Twas The Night", year: 2021 });
  assert.deepEqual(extract("2012 (2009) 1080p BluRay"), { title: "2012", year: 2009 });
  assert.deepEqual(extract("Blade Runner 2049 (2017) 2160p"), { title: "Blade Runner 2049", year: 2017 });
  assert.deepEqual(extract("1917.2019.1080p.WEB-DL"), { title: "1917", year: 2019 });
});

test("real subtitles with a dash are kept", () => {
  assert.equal(extract("Mission: Impossible - Fallout (2018) 1080p").title, "Mission: Impossible - Fallout");
});

test("bitrate/container debris is stripped", () => {
  assert.equal(extract("Mp4~0.4mbps720pmp4~0.4mbps Pad").title, "Pad");
});

test("::title keeps apostrophes and non-ASCII letters intact", () => {
  const out = (value) => renderAioStreamsFormat("{stream.title::title}", { title: value }, "test");
  assert.equal(out("a dog's perfect christmas"), "A Dog's Perfect Christmas");
  assert.equal(out("ngôi nhà về đêm"), "Ngôi Nhà Về Đêm");
});

test("episode-first names resolve to the show title", () => {
  const stream = { title: "S1 E1 - Rose | Doctor Who 1080p | Dual-Audio | • M3U8 • H 264 • AAC | 47 Min" };
  renderAioStreamsFormat("{stream.title}", stream, "test");
  assert.equal(stream.title, "Doctor Who");
  assert.equal(stream.episodeTitle, "Rose");
  assert.equal(stream.formattedSeasons, "S01");
  assert.equal(stream.formattedEpisodes, "E01");
  assert.equal(stream.encode, "AVC");
});
