// utils/calcProfit.js (backend)
// Server-side profit calculation updated to:
// - Simple interest (not compound).
// - Start counting profit immediately after deposit.startDate / approvedAt (no 24-hour delay).
// - Exclude weekends (count business minutes only).
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

// Count business minutes (Mon-Fri) between two timestamps (start inclusive, end exclusive)
function businessMinutesBetween(startDate, endDate) {
  const s = new Date(startDate)
  const e = new Date(endDate)
  if (e <= s) return 0

  // Normalize seconds/milliseconds to zero for consistent minute rounding
  s.setSeconds(0,0)
  e.setSeconds(0,0)

  let minutes = 0
  // We'll iterate day-by-day (at most 60 days -> cheap)
  const cur = new Date(s)
  while (cur < e) {
    const day = cur.getDay()
    // compute the end of this day segment (start of next day)
    const nextDay = new Date(cur)
    nextDay.setDate(nextDay.getDate() + 1)
    nextDay.setHours(0,0,0,0)

    // segmentEnd is the earlier of nextDay and e
    const segmentEnd = nextDay < e ? nextDay : e

    if (day !== 0 && day !== 6) {
      minutes += Math.floor((segmentEnd - cur) / (60 * 1000))
    }

    // advance cur to start of next day
    cur.setDate(cur.getDate() + 1)
    cur.setHours(0,0,0,0)
  }

  return minutes
}

// Map common deposit amounts to configured daily rates (simple interest percent per day)
// Updated rates per your request:
// 2% -> 5%, 2.5% -> 6%, 3% -> 7%, 4% -> 8%
function rateForAmount(amount) {
  const mapping = [
    { amount: 20, rate: 5 },
    { amount: 50, rate: 5 },
    { amount: 100, rate: 6 },
    { amount: 200, rate: 6 },
    { amount: 500, rate: 6 },
    { amount: 1000, rate: 7 },
    { amount: 2000, rate: 7 },
    { amount: 5000, rate: 7 },
    { amount: 10000, rate: 8 },
    { amount: 20000, rate: 8 }
  ]

  const exact = mapping.find(m => Number(m.amount) === Number(amount))
  if (exact) return exact.rate

  const sorted = mapping.map(m => m).sort((a,b)=>a.amount - b.amount)
  for (let i = sorted.length - 1; i >= 0; i--) {
    if (amount >= sorted[i].amount) return sorted[i].rate
  }
  return 5
}

// compute total profit earned for a deposit up to now (exclude weekends and capped at 60 calendar days)
// Profit counting NOW STARTS IMMEDIATELY at deposit.startDate or deposit.approvedAt (no 24-hour delay).
// Uses SIMPLE interest: dailyProfit = amount * (ratePercent/100)
// Accrues continuously by minute (minutes of business time are counted).
function profitForDeposit(deposit, asOf = new Date()) {
  if (!deposit) return 0

  // Accept either explicit startDate or approvedAt
  const startCandidate = deposit.startDate || deposit.approvedAt
  if (!startCandidate) return 0
  const start = new Date(startCandidate)
  const explicitEnd = deposit.endDate ? new Date(deposit.endDate) : null
  const asOfDate = new Date(asOf)

  // cap date is start + 60 calendar days
  const cap = new Date(start)
  cap.setDate(cap.getDate() + 60)

  // choose the earliest of explicitEnd, asOf, cap
  let upto = asOfDate
  if (explicitEnd && explicitEnd < upto) upto = explicitEnd
  if (cap < upto) upto = cap

  // NOTE: Profit starts immediately at `start` (no +24h)
  const profitStart = new Date(start.getTime())

  // if profitStart >= upto, nothing earned yet
  if (profitStart >= upto) return 0

  // minutes of business time between profitStart (inclusive) and upto (exclusive)
  const minutes = businessMinutesBetween(profitStart, upto)
  if (minutes <= 0) return 0

  // determine ratePercent (use deposit.ratePercent if present, otherwise infer)
  const ratePercent = (typeof deposit.ratePercent === 'number' && !isNaN(deposit.ratePercent))
    ? deposit.ratePercent
    : rateForAmount(Number(deposit.amount || deposit.capital || 0))

  const principal = Number(deposit.amount || deposit.capital || 0)
  const dailyProfit = principal * (ratePercent / 100) // simple interest per full day
  const profit = (dailyProfit * (minutes / (24 * 60)))

  // Return profit rounded to 2 decimals
  return Number(profit.toFixed(2))
}

/**
 * Helper: compute plan-style profit summary for a principal/rate/days window.
 * - businessDays: approximate weekdays in `days` calendar days (floor(days * 5/7))
 * - dailyProfit: principal * (ratePercent/100)  (simple interest per full day)
 * - totalProfit: dailyProfit * businessDays (profit only — that's what UI's "Total Return" shows)
 * - totalAfter: principal + totalProfit (final payout)
 *
 * This helper is for UI and plan previews. It does NOT change minute-accurate profitForDeposit logic.
 */
function planProfitForAmount(principal, ratePercent, days = 60) {
  const businessDays = Math.floor(days * 5 / 7)
  const rate = Number(ratePercent) / 100
  const dailyProfit = Number((Number(principal) * rate))
  const totalProfit = Number((dailyProfit * businessDays))
  const totalAfter = Number((Number(principal) + totalProfit))
  return {
    businessDays,
    dailyProfit: Number(dailyProfit.toFixed(2)),
    totalProfit: Number(totalProfit.toFixed(2)),
    totalAfter: Number(totalAfter.toFixed(2))
  }
}

module.exports = { businessDaysBetween, businessMinutesBetween, rateForAmount, profitForDeposit, planProfitForAmount }
