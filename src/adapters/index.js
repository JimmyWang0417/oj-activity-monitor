"use strict";

const { AtCoderAdapter } = require("./atcoder");
const { CodeforcesAdapter } = require("./codeforces");
const { LuoguAdapter } = require("./luogu");
const { NowcoderAdapter } = require("./nowcoder");
const { QojAdapter } = require("./qoj");
const { VJudgeAdapter } = require("./vjudge");

function createAdapters(options) {
  return {
    codeforces: new CodeforcesAdapter(options),
    atcoder: new AtCoderAdapter(options),
    vjudge: new VJudgeAdapter(options),
    luogu: new LuoguAdapter(options),
    nowcoder: new NowcoderAdapter(options),
    qoj: new QojAdapter(options)
  };
}

module.exports = { AtCoderAdapter, CodeforcesAdapter, LuoguAdapter, NowcoderAdapter, QojAdapter, VJudgeAdapter, createAdapters };
