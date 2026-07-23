(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.RelativeRotation = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const MODE_CONFIG = {
    "10-50": {
      label: "10/50",
      momentumLookback: 10,
      normalizationWindow: 50,
      smoothingWindow: 10,
      tailSpacing: 1,
      defaultTailPoints: 15
    }
  };
  const MAX_STALE_SESSIONS = 10;
  const EPSILON = 1e-12;
  const INTERNAL_CENTER = 100;
  const DISPLAY_CENTER = 50;
  const DISPLAY_MULTIPLIER = 15;

  const isFiniteNumber = value => Number.isFinite(value);
  const toDisplayScale = value =>
    DISPLAY_CENTER + (value - INTERNAL_CENTER) * DISPLAY_MULTIPLIER;

  function classifyQuadrant(x, y) {
    if (x >= DISPLAY_CENTER && y >= DISPLAY_CENTER) return "Leading";
    if (x >= DISPLAY_CENTER && y < DISPLAY_CENTER) return "Weakening";
    if (x < DISPLAY_CENTER && y < DISPLAY_CENTER) return "Lagging";
    return "Improving";
  }

  function rollingMean(values, windowSize) {
    const size = Math.max(1, Math.round(windowSize));
    const output = new Array(values.length).fill(NaN);
    for (let index = size - 1; index < values.length; index++) {
      const window = values.slice(index - size + 1, index + 1);
      if (!window.every(isFiniteNumber)) continue;
      output[index] = window.reduce((total, value) => total + value, 0) / size;
    }
    return output;
  }

  function rollingZScore(values, windowSize) {
    const size = Math.max(2, Math.round(windowSize));
    const output = new Array(values.length).fill(NaN);
    for (let index = size - 1; index < values.length; index++) {
      const window = values.slice(index - size + 1, index + 1);
      if (!window.every(isFiniteNumber)) continue;
      const mean = window.reduce((total, value) => total + value, 0) / size;
      const variance = window.reduce((total, value) => total + Math.pow(value - mean, 2), 0) / size;
      const std = Math.sqrt(variance);
      output[index] = std > EPSILON ? 100 + ((values[index] - mean) / std) : 100;
    }
    return output;
  }

  function fillSeries(rawPrices, rawCaps, rawTraded = null) {
    const prices = new Array(rawPrices.length).fill(NaN);
    const caps = new Array(rawCaps.length).fill(NaN);
    const stale = new Array(rawPrices.length).fill(Infinity);
    let lastPrice = NaN;
    let lastCap = NaN;
    let staleSessions = Infinity;

    for (let i = 0; i < rawPrices.length; i++) {
      const hasPrice = isFiniteNumber(rawPrices[i]) && rawPrices[i] > 0;
      const traded = rawTraded ? rawTraded[i] === true : hasPrice;
      if (hasPrice) {
        lastPrice = rawPrices[i];
      }
      if (traded) {
        staleSessions = 0;
      } else if (isFiniteNumber(lastPrice)) {
        staleSessions = isFiniteNumber(staleSessions) ? staleSessions + 1 : 1;
      }
      if (isFiniteNumber(rawCaps[i]) && rawCaps[i] > 0) lastCap = rawCaps[i];
      prices[i] = lastPrice;
      caps[i] = lastCap;
      stale[i] = staleSessions;
    }
    return { prices, caps, stale };
  }

  function constructWeightedIndex(data, tickerIds) {
    const levels = new Array(data.dates.length).fill(100);
    const activeCounts = new Array(data.dates.length).fill(0);
    const caps = new Array(data.dates.length).fill(NaN);

    for (let t = 0; t < data.dates.length; t++) {
      let capTotal = 0;
      tickerIds.forEach(ticker => {
        const series = data.stocks[ticker];
        if (series && isFiniteNumber(series.caps[t])) capTotal += series.caps[t];
      });
      caps[t] = capTotal || NaN;
      if (t === 0) continue;

      const valid = [];
      let weightTotal = 0;
      tickerIds.forEach(ticker => {
        const series = data.stocks[ticker];
        if (!series) return;
        const current = series.prices[t];
        const previous = series.prices[t - 1];
        const laggedCap = series.caps[t - 1];
        if (!isFiniteNumber(current) || !isFiniteNumber(previous) || previous <= 0) return;
        if (!isFiniteNumber(laggedCap) || laggedCap <= 0 || series.stale[t] > MAX_STALE_SESSIONS) return;
        valid.push({ weight: laggedCap, returnValue: current / previous - 1 });
        weightTotal += laggedCap;
      });
      activeCounts[t] = valid.length;
      const indexReturn = weightTotal
        ? valid.reduce((total, item) => total + (item.weight / weightTotal) * item.returnValue, 0)
        : 0;
      levels[t] = levels[t - 1] * (1 + indexReturn);
    }
    return { levels, activeCounts, caps };
  }

  function prepare(rawRows, coverage) {
    const coverageEntries = coverage instanceof Map ? [...coverage.entries()] : Object.entries(coverage || {});
    const sectorByTicker = Object.fromEntries(coverageEntries);
    const dates = [...new Set(rawRows.map(row => row.date).filter(Boolean))].sort();
    const dateIndex = new Map(dates.map((date, index) => [date, index]));
    const tickerSet = new Set(rawRows.filter(row => row.ticker && row.ticker !== "VNINDEX").map(row => row.ticker));
    const tickers = [...tickerSet].filter(ticker => sectorByTicker[ticker]).sort();
    const rawByTicker = {};
    tickers.forEach(ticker => {
      rawByTicker[ticker] = {
        prices: new Array(dates.length).fill(NaN),
        caps: new Array(dates.length).fill(NaN),
        traded: new Array(dates.length).fill(false)
      };
    });
    const rawBenchmark = new Array(dates.length).fill(NaN);

    rawRows.forEach(row => {
      const index = dateIndex.get(row.date);
      if (index === undefined) return;
      const price = Number(row.adjusted_last);
      if (row.ticker === "VNINDEX") {
        if (isFiniteNumber(price) && price > 0) rawBenchmark[index] = price;
        return;
      }
      const target = rawByTicker[row.ticker];
      if (!target) return;
      const cap = Number(row.market_cap_vnd_bn);
      const volume = Number(row.volume);
      if (isFiniteNumber(price) && price > 0) target.prices[index] = price;
      if (isFiniteNumber(cap) && cap > 0) target.caps[index] = cap;
      if (isFiniteNumber(volume) && volume > 0) target.traded[index] = true;
    });

    const stocks = {};
    tickers.forEach(ticker => {
      stocks[ticker] = {
        id: ticker,
        label: ticker,
        sector: sectorByTicker[ticker],
        ...fillSeries(rawByTicker[ticker].prices, rawByTicker[ticker].caps, rawByTicker[ticker].traded)
      };
    });

    const vnindex = fillSeries(rawBenchmark, new Array(dates.length).fill(NaN)).prices;
    const sectors = [...new Set(tickers.map(ticker => sectorByTicker[ticker]))].sort();
    const sectorMembers = Object.fromEntries(sectors.map(sector => [
      sector,
      tickers.filter(ticker => sectorByTicker[ticker] === sector)
    ]));
    const data = { dates, dateIndex, tickers, sectors, sectorMembers, stocks, vnindex };
    data.syntheticMarket = constructWeightedIndex(data, tickers);
    data.sectorIndices = Object.fromEntries(sectors.map(sector => [
      sector,
      constructWeightedIndex(data, sectorMembers[sector])
    ]));
    data.cache = new Map();
    return data;
  }

  function calculate(data, options) {
    const view = options.view === "stocks" ? "stocks" : "sectors";
    const mode = MODE_CONFIG[options.mode] ? options.mode : "10-50";
    const benchmarkKey = options.benchmark === "vnindex" ? "vnindex" : "synthetic-market";
    const cacheKey = `${view}|${mode}|${benchmarkKey}`;
    if (data.cache.has(cacheKey)) return data.cache.get(cacheKey);

    const config = MODE_CONFIG[mode];
    const entityIds = view === "stocks" ? data.tickers : data.sectors;
    const benchmark = benchmarkKey === "vnindex" ? data.vnindex : data.syntheticMarket.levels;
    const entities = {};
    entityIds.forEach(id => {
      if (view === "stocks") {
        const stock = data.stocks[id];
        entities[id] = { id, label: id, sector: stock.sector, levels: stock.prices, caps: stock.caps, stale: stock.stale };
      } else {
        const sector = data.sectorIndices[id];
        entities[id] = { id, label: id, sector: id, levels: sector.levels, caps: sector.caps, stale: new Array(data.dates.length).fill(0) };
      }
    });

    const relativePrice = {};
    const rawRatio = {};
    const ratioMomentum = {};
    const rawMomentum = {};
    const x = {};
    const y = {};
    entityIds.forEach(id => {
      const entity = entities[id];
      const relative = new Array(data.dates.length).fill(NaN);
      let entityBase = NaN;
      let benchmarkBase = NaN;
      for (let t = 0; t < data.dates.length; t++) {
        const entityLevel = entity.levels[t];
        const benchmarkLevel = benchmark[t];
        if (![entityLevel, benchmarkLevel].every(isFiniteNumber) || entityLevel <= 0 || benchmarkLevel <= 0) continue;
        if (view === "stocks" && entity.stale[t] > MAX_STALE_SESSIONS) continue;
        if (!isFiniteNumber(entityBase)) {
          entityBase = entityLevel;
          benchmarkBase = benchmarkLevel;
        }
        relative[t] = (entityLevel / entityBase) / (benchmarkLevel / benchmarkBase);
      }

      const ratio = rollingZScore(relative, config.normalizationWindow);
      const momentum = new Array(data.dates.length).fill(NaN);
      for (let t = config.momentumLookback; t < data.dates.length; t++) {
        const currentRatio = ratio[t];
        const previousRatio = ratio[t - config.momentumLookback];
        if (isFiniteNumber(currentRatio) && isFiniteNumber(previousRatio) && Math.abs(previousRatio) > EPSILON) {
          momentum[t] = currentRatio / previousRatio;
        }
      }
      const normalizedMomentum = rollingZScore(momentum, config.normalizationWindow);
      relativePrice[id] = relative;
      rawRatio[id] = ratio;
      ratioMomentum[id] = momentum;
      rawMomentum[id] = normalizedMomentum;
      x[id] = rollingMean(ratio, config.smoothingWindow);
      y[id] = rollingMean(normalizedMomentum, config.smoothingWindow);
    });

    const result = {
      data, view, mode, benchmarkKey, benchmark, config, entityIds, entities,
      relativePrice, rawRatio, ratioMomentum, rawMomentum, x, y
    };
    data.cache.set(cacheKey, result);
    return result;
  }

  function effectiveDateIndex(calc, requestedDate) {
    const dates = calc.data.dates;
    if (!requestedDate) return dates.length - 1;
    let index = dates.length - 1;
    while (index > 0 && dates[index] > requestedDate) index -= 1;
    return index;
  }

  function pointAt(calc, id, index) {
    const entity = calc.entities[id];
    const internalX = calc.x[id]?.[index];
    const internalY = calc.y[id]?.[index];
    if (!entity || !isFiniteNumber(internalX) || !isFiniteNumber(internalY)) return null;
    const x = toDisplayScale(internalX);
    const y = toDisplayScale(internalY);
    const lookbackIndex = index - calc.config.momentumLookback;
    const entityReturn = lookbackIndex >= 0 && isFiniteNumber(entity.levels[lookbackIndex])
      ? entity.levels[index] / entity.levels[lookbackIndex] - 1
      : NaN;
    const benchmarkReturn = lookbackIndex >= 0 && isFiniteNumber(calc.benchmark[lookbackIndex])
      ? calc.benchmark[index] / calc.benchmark[lookbackIndex] - 1
      : NaN;
    return {
      id,
      label: entity.label,
      sector: entity.sector,
      date: calc.data.dates[index],
      index,
      x,
      y,
      score: Math.max(0, Math.min(100, (x + y) / 2)),
      relativePrice: calc.relativePrice[id][index],
      rawRatio: toDisplayScale(calc.rawRatio[id][index]),
      ratioMomentum: calc.ratioMomentum[id][index],
      rawMomentum: toDisplayScale(calc.rawMomentum[id][index]),
      entityReturn,
      benchmarkReturn,
      relativeOutperformance: lookbackIndex >= 0 && isFiniteNumber(calc.relativePrice[id][lookbackIndex])
        ? calc.relativePrice[id][index] / calc.relativePrice[id][lookbackIndex] - 1
        : NaN,
      quadrant: classifyQuadrant(x, y),
      marketCap: entity.caps[index],
      staleSessions: entity.stale[index]
    };
  }

  function snapshot(calc, requestedDate) {
    const index = effectiveDateIndex(calc, requestedDate);
    return calc.entityIds.map(id => pointAt(calc, id, index)).filter(Boolean);
  }

  function selectTail(calc, id, requestedDate, numberOfPoints) {
    const endIndex = effectiveDateIndex(calc, requestedDate);
    const points = [];
    const count = Math.max(2, Math.round(numberOfPoints || calc.config.defaultTailPoints));
    for (let offset = count - 1; offset >= 0; offset--) {
      const index = endIndex - calc.config.tailSpacing * offset;
      if (index < 0) continue;
      const point = pointAt(calc, id, index);
      if (point) points.push(point);
    }
    points.forEach((point, index) => {
      if (index === 0) {
        point.deltaX = NaN;
        point.deltaY = NaN;
      } else {
        point.deltaX = point.x - points[index - 1].x;
        point.deltaY = point.y - points[index - 1].y;
      }
    });
    return points;
  }

  return {
    MODE_CONFIG,
    MAX_STALE_SESSIONS,
    DISPLAY_CENTER,
    DISPLAY_MULTIPLIER,
    calculate,
    classifyQuadrant,
    constructWeightedIndex,
    effectiveDateIndex,
    pointAt,
    prepare,
    rollingMean,
    rollingZScore,
    selectTail,
    snapshot
  };
});
