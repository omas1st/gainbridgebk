// utils/calcProfit.js (backend)
// Server-side profit calculation updated to:
// - Start counting profit only after 24 hours from deposit startDate (approval time).
// - Exclude weekends (count business days only).
// - Cap profit at 60 calendar days from startDate (so typical result for 60-day window is ~42 business days).
'use strict'

// Helpers to compute number of business days (exclude weekends) between two dates (inclusive start exclusive end)
function businessDaysBetween(startDate, endDate) {
  const s = new Date(startDate)
  const e = new Date(endDate)
  s.setHours(0,0,0,0)
  e.setHours(0,0,0,0)
  if (e <= s) return 0
  let count = 0
  const cur = new Date(s)
  while (cur < e) {
    const day = cur.getDay()
    if (day !== 0 && day !== 6) count++
    cur.setDate(cur.getDate() + 1)
  }
  return count
}

// compound daily growth for n days (ratePercent per day)
function compound(amount, ratePercent, days) {
  const r = ratePercent/100
  let total = amount
  for (let i=0;i<days;i++) total *= (1 + r)
  return total
}

// Map common deposit amounts to configured daily rates (fallback if deposit.ratePercent not set)
function rateForAmount(amount) {
  const mapping = [
    { amount: 20, rate: 2 },
    { amount: 50, rate: 2 },
    { amount: 100, rate: 2.5 },
    { amount: 200, rate: 2.5 },
    { amount: 500, rate: 2.5 },
    { amount: 1000, rate: 3 },
    { amount: 2000, rate: 3 },
    { amount: 5000, rate: 3 },
    { amount: 10000, rate: 4 },
    { amount: 20000, rate: 4 }
  ]

  const exact = mapping.find(m => Number(m.amount) === Number(amount))
  if (exact) return exact.rate

  const sorted = mapping.map(m => m).sort((a,b)=>a.amount - b.amount)
  for (let i = sorted.length - 1; i >= 0; i--) {
    if (amount >= sorted[i].amount) return sorted[i].rate
  }
  return 2
}

// compute total profit earned for a deposit up to now (exclude weekends and capped at 60 calendar days)
// Profit counting starts after 24 hours from deposit.startDate (i.e., first profit is available only after 24h has passed).
function profitForDeposit(deposit, asOf = new Date()) {
  if (!deposit || !deposit.startDate) return 0

  const start = new Date(deposit.startDate)
  const explicitEnd = deposit.endDate ? new Date(deposit.endDate) : null
  const asOfDate = new Date(asOf)

  // cap date is start + 60 calendar days
  const cap = new Date(start)
  cap.setDate(cap.getDate() + 60)

  // choose the earliest of explicitEnd, asOf, cap
  let upto = asOfDate
  if (explicitEnd && explicitEnd < upto) upto = explicitEnd
  if (cap < upto) upto = cap

  // compute profit start = start + 24 hours (profit only accrues after full 24 hours)
  const profitStart = new Date(start.getTime() + (24 * 60 * 60 * 1000))

  // if profitStart >= upto, nothing earned yet
  if (profitStart >= upto) return 0

  // number of business days (weekdays) between profitStart (inclusive) and upto (exclusive)
  const days = businessDaysBetween(profitStart, upto)
  if (days <= 0) return 0

  // determine ratePercent (use deposit.ratePercent if present, otherwise infer)
  const ratePercent = (typeof deposit.ratePercent === 'number' && !isNaN(deposit.ratePercent))
    ? deposit.ratePercent
    : rateForAmount(Number(deposit.amount || 0))

  const total = compound(Number(deposit.amount || 0), ratePercent, days)
  return total - Number(deposit.amount || 0)
}

module.exports = { businessDaysBetween, compound, profitForDeposit, rateForAmount }
