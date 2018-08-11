const _ = require('lodash');

const util = require('../../core/util');
const ENV = util.gekkoEnv();

const config = util.getConfig();
const calcConfig = config.paperTrader;
const watchConfig = config.watch;
const dirs = util.dirs();
const log = require(dirs.core + 'log');

const TrailingStop = require(dirs.core + 'triggers/trailingStop');

const PaperTrader = function() {
  _.bindAll(this);

  if(calcConfig.feeUsing === 'maker') {
    this.rawFee = calcConfig.feeMaker;
  } else {
    this.rawFee = calcConfig.feeTaker;
  }

  this.fee = 1 - this.rawFee / 100;

  this.currency = watchConfig.currency;
  this.asset = watchConfig.asset;

  this.portfolio = {
    asset: calcConfig.simulationBalance.asset,
    currency: calcConfig.simulationBalance.currency,
  }

  this.balance = false;

  if(this.portfolio.asset > 0) {
    this.exposed = true;
  }

  this.propogatedTrades = 0;
}

PaperTrader.prototype.relayPortfolioChange = function() {
  this.deferredEmit('portfolioChange', {
    asset: this.portfolio.asset,
    currency: this.portfolio.currency
  });
}

PaperTrader.prototype.relayPortfolioValueChange = function() {
  this.deferredEmit('portfolioValueChange', {
    balance: this.getBalance()
  });
}

PaperTrader.prototype.extractFee = function(amount) {
  amount *= 1e8;
  amount *= this.fee;
  amount = Math.floor(amount);
  amount /= 1e8;
  return amount;
}

PaperTrader.prototype.setStartBalance = function() {
  this.balance = this.getBalance();
}

// after every succesfull trend ride we hopefully end up
// with more BTC than we started with, this function
// calculates Gekko's profit in %.
PaperTrader.prototype.updatePosition = function(what) {

  let cost;
  let amount;

  // virtually trade all {currency} to {asset}
  // at the current price (minus fees)
  if(what === 'long') {
    cost = (1 - this.fee) * this.portfolio.currency;
    this.portfolio.asset += this.extractFee(this.portfolio.currency / this.price);
    amount = this.portfolio.asset;
    this.portfolio.currency = 0;

    this.exposed = true;
    this.trades++;
  }

  // virtually trade all {currency} to {asset}
  // at the current price (minus fees)
  else if(what === 'short') {
    cost = (1 - this.fee) * (this.portfolio.asset * this.price);
    this.portfolio.currency += this.extractFee(this.portfolio.asset * this.price);
    amount = this.portfolio.currency / this.price;
    this.portfolio.asset = 0;

    this.exposed = false;
    this.trades++;
  }

  const effectivePrice = this.price * this.fee;

  return { cost, amount, effectivePrice };
}

PaperTrader.prototype.getBalance = function() {
  return this.portfolio.currency + this.price * this.portfolio.asset;
}

PaperTrader.prototype.processAdvice = function(advice) {
  let action;
  if(advice.recommendation === 'short') {
    action = 'sell';

    // clean up potential old stop trigger
    if(this.activeStopTrigger) {
      delete this.activeStopTrigger;
    }

  } else if(advice.recommendation === 'long') {
    action = 'buy';

    if(advice.stop) {
      this.createStop(advice.stop);
    }
  } else {
    return log.warn(
      `[Papertrader] ignoring unknown advice recommendation: ${advice.recommendation}`
    );
  }

  this.tradeId = 'trade-' + (++this.propogatedTrades);

  this.deferredEmit('tradeInitiated', {
    id: this.tradeId,
    adviceId: advice.id,
    action,
    portfolio: _.clone(this.portfolio),
    balance: this.getBalance(),
    date: advice.date,
  });

  const { cost, amount, effectivePrice } = this.updatePosition(advice.recommendation);

  this.relayPortfolioChange();
  this.relayPortfolioValueChange();

  this.deferredEmit('tradeCompleted', {
    id: this.tradeId,
    adviceId: advice.id,
    action,
    cost,
    amount,
    price: this.price,
    portfolio: this.portfolio,
    balance: this.getBalance(),
    date: advice.date,
    effectivePrice,
    feePercent: this.rawFee
  });
}

PaperTrader.prototype.createStop = function(stop) {
  if(stop.type === 'trailing') {

    if(stop.trailPercentage && !stop.trailValue) {
      stop.trailValue = stop.trailPercentage / 100 * this.price;
    }

    if(!stop.trailValue) {
      return log.warn(`[Papertrader] ignoring trailing stop without trail value`);
    }

    // TODO: emit trigger created

    this.activeStopTrigger = {
      adviceId: advice.id,
      instance: new TrailingStop({
        initialPrice: this.price,
        trail: stop.trailValue,
        onTrigger: this.triggerStop
      });
    }
  }
}

PaperTrader.prototype.triggerStop = function() {
  // TODO: emit trigger stopped
  this.updatePosition('short');
}

PaperTrader.prototype.processCandle = function(candle, done) {
  this.price = candle.close;

  if(!this.balance) {
    this.setStartBalance();
    this.relayPortfolioChange();
    this.relayPortfolioValueChange();
  }

  if(this.exposed) {
    this.relayPortfolioValueChange();
  }

  if(this.activeStopTrigger) {
    this.activeStopTrigger.updatePrice(this.price);
  }

  done();
}

module.exports = PaperTrader;
