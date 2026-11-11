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

test("tags are detected outside the title and release groups must be one token", () => {
  const s = { title: "S1 E1 - Rose | Doctor Who 1080p | Dual-Audio | • M3U8 • H 264 • AAC | 47 Min" };
  renderAioStreamsFormat("{stream.title}", s, "test");
  assert.deepEqual(s.languages, ["Dual Audio"]);
  assert.deepEqual(s.audioTags, ["AAC"]);
  assert.equal(s.releaseGroup, undefined);

  // Words inside the title must not become tags ("Dual", "Cam").
  const t = { title: "Dual.Cam.Chronicles.2020.1080p.WEB-DL.DDP5.1.Atmos.H.265-GRP.mkv" };
  renderAioStreamsFormat("{stream.title}", t, "test");
  assert.equal(t.title, "Dual Cam Chronicles");
  assert.equal(t.quality, "WEB-DL");
  assert.equal(t.languages, undefined);
  assert.deepEqual(t.audioTags, ["Atmos", "DD+"]);
  assert.deepEqual(t.audioChannels, ["5.1"]);
  assert.equal(t.encode, "HEVC");
  assert.equal(t.releaseGroup, "GRP");
});

test("multi-line descriptions pick the line that looks like a release name", () => {
  const s = { description: "🎬 Provider\n📦 2 GB\nName: The.Movie.2021.1080p.BluRay.x264-GRP" };
  renderAioStreamsFormat("{stream.title}", s, "test");
  assert.equal(s.title, "The Movie");
  assert.equal(s.year, 2021);
});

const withMetadata = (title, metadata) => {
  const stream = { title };
  renderAioStreamsFormat("{stream.title}", stream, "test", { metadata });
  return stream;
};

test("requested metadata repairs near-miss titles and reports whether they matched", () => {
  const meta = { title: "A Dog's Perfect Christmas", year: 2026 };
  assert.equal(withMetadata("A Dogs Perfect Christmas (2026) 1080p", meta).title, "A Dog's Perfect Christmas");
  assert.equal(withMetadata("A Dog's Perfect Christmas HubCloud FSL", meta).title, "A Dog's Perfect Christmas");
  assert.equal(withMetadata("A Dog's Perfect Christmas (2026)", meta).titleMatched, true);
  assert.equal(withMetadata("Totally Different Movie (2026)", meta).titleMatched, false);
  assert.equal(
    withMetadata("Ngoi Nha Ve Dem 2021 1080p", { title: "Ngôi Nhà Về Đêm", aliases: ["The Night House"] }).title,
    "Ngôi Nhà Về Đêm"
  );
  // Digit tokens must agree: a sequel is not a match.
  assert.equal(withMetadata("Toy Story 3 2010 1080p", { title: "Toy Story 2" }).titleMatched, false);
});

test("requested year wins when several years appear", () => {
  assert.equal(withMetadata("Movie 2019 2021 1080p", { title: "Movie", year: 2021 }).year, 2021);
});

test("usenet repost suffixes are not read as the release group", () => {
  const s = { title: "The.Movie.2021.1080p.WEB-DL.H.264-GRP-NZBGeek.mkv" };
  renderAioStreamsFormat("{stream.title}", s, "test");
  assert.equal(s.releaseGroup, "GRP");
});

test("wrapped plugins use the most common title when no media title is passed", async () => {
  const { DEFAULT_STREAM_MIDDLEWARE, wrapPluginStreams } = await import("../dist/providers/stream-middleware.js");
  const fixtures = [
    { title: "A.Dog's.Perfect.Christmas.2026.1080p.WEB-DL.mkv", url: "https://x/1" },
    { title: "A Dog's Perfect Christmas (2026) 720p", url: "https://x/2" },
    { title: "A Dog's Perfect Christmas HubCloud FSL", url: "https://x/3" },
    { title: "Unrelated Thing (2020) 1080p", url: "https://x/4" }
  ];
  const run = async (args) => {
    const module = { exports: {} };
    new Function("module", "exports", "fixtures", wrapPluginStreams(
      "module.exports = { getStreams: async () => fixtures.map(item => ({ ...item })) };",
      { ...DEFAULT_STREAM_MIDDLEWARE, format: "{stream.title}|{stream.titleMatched}" }
    ))(module, module.exports, fixtures);
    return module.exports.getStreams(...args);
  };

  const byUrl = (streams) => Object.fromEntries(streams.map((item) => [item.url, item.title]));
  const inferred = byUrl(await run(["603", "movie"]));
  assert.equal(inferred["https://x/3"], "A Dog's Perfect Christmas|true");
  assert.equal(inferred["https://x/4"], "Unrelated Thing|false");

  const explicit = byUrl(await run([{ id: "1", title: "A Dog's Perfect Christmas", year: 2026 }]));
  assert.equal(explicit["https://x/3"], "A Dog's Perfect Christmas|true");
});
