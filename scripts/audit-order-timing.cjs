#!/usr/bin/env node
// Read only: distinguish proven deadline violations from legacy missing evidence.
const fs=require('node:fs'),path=require('node:path');
const {getStrategyDefinitions,runtimeFilesForStrategy}=require('../lib/strategy-registry.cjs');
const root=path.resolve(__dirname,'..');
for(const strategy of getStrategyDefinitions(root)) {
 const file=runtimeFilesForStrategy(root,strategy.slug).statePath;
 if(!fs.existsSync(file))continue;
 const state=JSON.parse(fs.readFileSync(file,'utf8'));
 for(const trade of state.trades||[]) {
  const fill=Date.parse(trade.filledAt),observed=Date.parse(trade.execution?.observedAt||trade.signalContext?.observedAt),expiry=Date.parse(trade.execution?.orderExpiresAt);
  const delay=(fill-observed)/60000;
  if((Number.isFinite(expiry)&&fill>=expiry)||delay>3)console.log(JSON.stringify({strategy:strategy.slug,id:trade.id,filledAt:trade.filledAt,observedAt:trade.execution?.observedAt||trade.signalContext?.observedAt,delayMinutes:Math.round(delay*100)/100,orderExpiresAt:trade.execution?.orderExpiresAt||null,policyVersion:trade.execution?.policyVersion||null,status:Number.isFinite(expiry)?(fill>=expiry?'DEADLINE VIOLATION':'within explicit deadline'):'legacy trade: deadline not recorded; cannot prove compliance'}));
 }
}
