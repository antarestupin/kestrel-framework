/** Validate every lease before writing: Lua isolation does not provide rollback. */
export const mutateLocks = `
local expected = {'string', 'string'}
for i, kind in ipairs(expected) do
  local actual = redis.call('TYPE', KEYS[i]).ok
  if actual ~= 'none' and actual ~= kind then return redis.error_reply('Invalid Redis adapter key type') end
end
local mode = ARGV[1]
local requests = cjson.decode(ARGV[2])
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local leases = {}
for i, request in ipairs(requests) do
  local raw = redis.call('GET', KEYS[i + 1])
  local lease = raw and cjson.decode(raw) or nil
  if lease and (lease.version ~= 1 or type(lease.ownerId) ~= 'string'
      or not tonumber(lease.expiresAt) or type(lease.fencingToken) ~= 'string') then
    return redis.error_reply('Invalid Redis lock record')
  end
  if mode == 'acquire' then
    if lease and tonumber(lease.expiresAt) > now then return false end
  elseif not lease or lease.ownerId ~= request.ownerId or tonumber(lease.expiresAt) <= now then
    return false
  end
  leases[i] = lease or {}
end
local token
if mode == 'acquire' then
  token = redis.call('GET', KEYS[1]) or '0'
  if not string.match(token, '^%d+$') then return redis.error_reply('Invalid Redis fencing sequence') end
  -- Reserve the complete range before writing leases, including the overflow check.
  redis.call('INCRBY', KEYS[1], #requests)
end
local function increment(value)
  local digits, carry = {}, 1
  for i = #value, 1, -1 do
    local digit = tonumber(string.sub(value, i, i)) + carry
    digits[i], carry = tostring(digit % 10), math.floor(digit / 10)
  end
  return (carry == 1 and '1' or '') .. table.concat(digits)
end
for i, request in ipairs(requests) do
  if token then token = increment(token) end
  local lease = {version = 1, key = request.key, ownerId = request.ownerId,
    expiresAt = string.format('%.0f', now + request.ttlMs), fencingToken = token or leases[i].fencingToken}
  redis.call('SET', KEYS[i + 1], cjson.encode(lease), 'PXAT', lease.expiresAt)
  leases[i] = lease
end
return cjson.encode(leases)
`;

/** An old owner can never delete its successor's lease. */
export const releaseLock = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local lease = cjson.decode(raw)
if lease.version ~= 1 or type(lease.ownerId) ~= 'string' then
  return redis.error_reply('Invalid Redis lock record')
end
if lease.ownerId ~= ARGV[1] then return 0 end
return redis.call('DEL', KEYS[1])
`;
