/** Stage the entire decision before writes; rejected batches never consume partial capacity. */
export const rateLimitScript = `
-- Redis cjson emits at most 14 significant digits: keep arithmetic state as decimal strings.
local function decimal(value) return string.format('%.17g', value) end
local function finite(value) return type(value) == 'number' and value == value and math.abs(value) < math.huge end
local mode = ARGV[1]
local requests = cjson.decode(ARGV[2])
local returns = cjson.decode(ARGV[3])
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local states, byKey, remaining, allocations, inspections = {}, {}, {}, {}, {}
local returned, retryDelay = 0, 0
for i, request in ipairs(requests) do
  local raw = redis.call('GET', KEYS[i])
  local state = raw and cjson.decode(raw) or nil
  if state then
    state.tokens, state.at = tonumber(state.tokens), tonumber(state.at)
    state.limit, state.periodMs, state.burst = tonumber(state.limit), tonumber(state.periodMs), tonumber(state.burst)
    if state.version ~= 1 or not finite(state.tokens) or not finite(state.at)
        or not finite(state.limit) or state.limit <= 0
        or not finite(state.periodMs) or state.periodMs <= 0
        or not finite(state.burst) or state.burst <= 0 or type(state.leases) ~= 'table' then
      return redis.error_reply('Invalid Redis rate limit record')
    end
    if mode ~= 'return' and state.signature ~= request.signature then
      return cjson.encode({conflict = request.key})
    end
  elseif mode ~= 'return' then
    state = {version = 1, signature = request.signature, tokens = request.burst,
      at = now, limit = request.limit, periodMs = request.periodMs, burst = request.burst, leases = {}}
  end
  if state then
    state.tokens = math.min(state.burst, state.tokens + math.max(0, now - state.at) * (state.limit / state.periodMs))
    state.at = math.max(now, state.at)
    for id, lease in pairs(state.leases) do
      lease.units, lease.expiresAt = tonumber(lease.units), tonumber(lease.expiresAt)
      if not finite(lease.units) or lease.units <= 0 or not finite(lease.expiresAt) then
        return redis.error_reply('Invalid Redis rate limit lease')
      end
      if lease.expiresAt <= now then state.leases[id] = nil end
    end
    states[i] = state
    byKey[request.key] = state
  end
end
-- Returned grants are refunded once, and only while their original lease is live.
for _, grant in ipairs(returns) do
  local state = byKey[grant.key]
  local lease = state and state.leases[grant.leaseId]
  if lease then
    state.tokens = math.min(state.burst, state.tokens + math.min(lease.units, grant.remaining))
    state.leases[grant.leaseId] = nil
    returned = returned + 1
  end
end
if mode ~= 'return' then
  for i, request in ipairs(requests) do
    local state = states[i]
    remaining[request.key] = state.tokens
    if mode == 'reconcile' then
      state.tokens = math.min(state.burst, state.tokens - request.delta)
      remaining[request.key] = state.tokens
    elseif state.tokens + 0.0000000000000002 < request.cost then
      retryDelay = math.max(retryDelay, math.max(0, state.at - now) + math.max(1, math.ceil((request.cost - state.tokens) / (state.limit / state.periodMs))))
    end
    if mode == 'inspect' then
      local delay = state.tokens >= request.cost and 0 or math.max(0, state.at - now) + math.max(1, math.ceil((request.cost - state.tokens) / (state.limit / state.periodMs)))
      inspections[i] = {available = state.tokens >= request.cost, remaining = state.tokens, retryDelayMs = delay}
    end
  end
end
if retryDelay == 0 and (mode == 'reserve' or mode == 'allocate') then
  for i, request in ipairs(requests) do
    local state = states[i]
    local units = request.cost
    local coordination = request.coordination
    local allocation = {mode = 'exact'}
    if mode == 'allocate' then
      local outstanding = 0
      for _, lease in pairs(state.leases) do outstanding = outstanding + lease.units end
      local headroom = math.max(0, coordination.maxOutstandingUnits - outstanding)
      if state.tokens > coordination.guardBandUnits + request.cost + 0.0000000000000002
          and headroom + 0.0000000000000002 >= request.cost then
        units = math.min(coordination.maxLeaseUnits, headroom, math.max(request.cost, state.tokens - coordination.guardBandUnits))
        allocation = {mode = 'lease', leaseId = request.leaseId, units = units, expiresAt = now + coordination.leaseMs}
        state.leases[request.leaseId] = {units = units, expiresAt = allocation.expiresAt}
      end
    end
    state.tokens = math.max(0, state.tokens - units)
    remaining[request.key] = state.tokens
    allocation.remaining = state.tokens
    allocations[request.key] = allocation
  end
end
if mode ~= 'inspect' and (retryDelay == 0 or mode == 'allocate') then
  local pending = {}
  for i, request in ipairs(requests) do
    local state = states[i]
    if state then
      -- Expiration must not forget outstanding grants, including after a bucket refills.
      local expiresAt = state.at + math.max(1, math.ceil((state.burst - state.tokens) / (state.limit / state.periodMs)))
      for _, lease in pairs(state.leases) do expiresAt = math.max(expiresAt, lease.expiresAt) end
      if not finite(state.tokens) or not finite(expiresAt) or expiresAt > 8640000000000000 then
        return redis.error_reply('Rate limit refill deadline is not representable')
      end
      local stored = {version = 1, signature = state.signature, tokens = decimal(state.tokens),
        at = decimal(state.at), limit = decimal(state.limit), periodMs = decimal(state.periodMs), burst = decimal(state.burst), leases = {}}
      for id, lease in pairs(state.leases) do
        stored.leases[id] = {units = decimal(lease.units), expiresAt = decimal(lease.expiresAt)}
      end
      pending[i] = {value = cjson.encode(stored), expiresAt = string.format('%.0f', math.ceil(expiresAt))}
    end
  end
  -- Complete every serialization/deadline check before beginning the commit phase.
  for i, _ in ipairs(requests) do
    if pending[i] then redis.call('SET', KEYS[i], pending[i].value, 'PXAT', pending[i].expiresAt) end
  end
end
for key, value in pairs(remaining) do remaining[key] = decimal(value) end
for _, allocation in pairs(allocations) do
  allocation.remaining = decimal(allocation.remaining)
  if allocation.mode == 'lease' then
    allocation.units, allocation.expiresAt = decimal(allocation.units), decimal(allocation.expiresAt)
  end
end
for _, inspection in ipairs(inspections) do
  inspection.remaining, inspection.retryDelayMs = decimal(inspection.remaining), decimal(inspection.retryDelayMs)
end
return cjson.encode({admitted = retryDelay == 0, remaining = remaining,
  serverNow = decimal(now), retryDelayMs = decimal(retryDelay), allocations = allocations, inspections = inspections, returned = returned})
`;
