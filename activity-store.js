const state = {
  startedAt: new Date().toISOString(),
  orders: [],
  payments: [],
  reports: []
}

function pushLimited(list, item, limit = 50) {
  list.unshift(item)
  if (list.length > limit) list.length = limit
}

export function recordOrder(order) {
  pushLimited(state.orders, { at: new Date().toISOString(), ...order })
}

export function recordPayment(payment) {
  pushLimited(state.payments, { at: new Date().toISOString(), ...payment })
}

export function recordReport(report) {
  pushLimited(state.reports, { at: new Date().toISOString(), ...report })
}

export function getActivity() {
  return {
    startedAt: state.startedAt,
    orders: state.orders,
    payments: state.payments,
    reports: state.reports
  }
}
