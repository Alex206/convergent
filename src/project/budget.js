'use strict';

const { normalizeAmount, roundCredits, text } = require('./model');

function budgetSnapshot(budget) {
  return {
    ...budget,
    ledger: Array.isArray(budget.ledger) ? [...budget.ledger] : [],
  };
}

function availableBudget(budget) {
  return roundCredits(budget.total - budget.spent - budget.reserved);
}

function remainingBudget(budget) {
  return roundCredits(budget.total - budget.spent);
}

function assertPositive(value, field) {
  const amount = normalizeAmount(value, field);
  if (amount <= 0) throw new Error(`${field} must be greater than zero.`);
  return amount;
}

function appendLedger(budget, event, amount, details = {}) {
  budget.ledger.push({
    eventId: event.id,
    type: event.type,
    amount,
    ...(event.at ? { at: event.at } : {}),
    ...(details.scopeId ? { scopeId: details.scopeId } : {}),
    ...(details.reservedAmount ? { reservedAmount: details.reservedAmount } : {}),
  });
}

function applyBudgetEvent(currentBudget, event) {
  const budget = budgetSnapshot(currentBudget);
  const scopeId = event.data.scopeId ? text(event.data.scopeId, 'budget scopeId') : null;
  const amount = assertPositive(event.data.amount, 'budget amount');

  if (event.type === 'BUDGET_RESERVED') {
    if (amount > availableBudget(budget)) {
      throw new Error(`Cannot reserve ${amount}; only ${availableBudget(budget)} ${budget.unit} are available.`);
    }
    budget.reserved = roundCredits(budget.reserved + amount);
    appendLedger(budget, event, amount, { scopeId });
  } else if (event.type === 'BUDGET_RELEASED') {
    if (amount > budget.reserved) {
      throw new Error(`Cannot release ${amount}; only ${budget.reserved} ${budget.unit} are reserved.`);
    }
    budget.reserved = roundCredits(budget.reserved - amount);
    appendLedger(budget, event, amount, { scopeId });
  } else if (event.type === 'BUDGET_SPENT') {
    const reservedAmount = normalizeAmount(event.data.reservedAmount ?? 0, 'reservedAmount');
    if (reservedAmount > amount) throw new Error('reservedAmount cannot exceed spent amount.');
    if (reservedAmount > budget.reserved) {
      throw new Error(`Cannot consume ${reservedAmount} reserved credits; only ${budget.reserved} are reserved.`);
    }
    const unreservedAmount = roundCredits(amount - reservedAmount);
    if (unreservedAmount > availableBudget(budget)) {
      throw new Error(`Cannot spend ${amount}; unreserved spend exceeds available project budget.`);
    }
    budget.reserved = roundCredits(budget.reserved - reservedAmount);
    budget.spent = roundCredits(budget.spent + amount);
    appendLedger(budget, event, amount, { scopeId, reservedAmount });
  } else {
    throw new Error(`Event ${event.type} is not a budget event.`);
  }

  budget.remaining = remainingBudget(budget);
  budget.available = availableBudget(budget);
  return budget;
}

module.exports = {
  applyBudgetEvent,
  availableBudget,
  remainingBudget,
};