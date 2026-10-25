/** Redis 7.4+ hash-field expiration keeps records and lookup indexes self-cleaning. */
export const sessionScript = `
local expected = {'hash', 'hash', 'hash'}
for i, kind in ipairs(expected) do
  local actual = redis.call('TYPE', KEYS[i]).ok
  if actual ~= 'none' and actual ~= kind then return redis.error_reply('Invalid Redis adapter key type') end
end
local mode = ARGV[1]
local input = cjson.decode(ARGV[2])
local records, digests, accounts = KEYS[1], KEYS[2], KEYS[3]
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local function load(id)
  local raw = redis.call('HGET', records, id)
  if not raw then return nil end
  local session = cjson.decode(raw)
  if session.version ~= 1 or session.id ~= id or type(session.digest) ~= 'string'
      or type(session.accountId) ~= 'string' or not tonumber(session.absoluteExpiresAt)
      or not tonumber(session.idleExpiresAt) or not tonumber(session.lastSeenAt) then
    error('Invalid Redis session record')
  end
  return session
end
-- Fail before writing on Redis versions without hash-field expiration.
redis.call('HPEXPIRETIME', records, 'FIELDS', 1, '')
local function expire(key, field, at)
  redis.call('HPEXPIREAT', key, at, 'FIELDS', 1, field)
end
local function save(session)
  redis.call('HSET', records, session.id, cjson.encode(session))
  -- Retain idle-expired and revoked sessions until absolute expiry for administration.
  expire(records, session.id, session.absoluteExpiresAt)
end
local function accountIndex(accountId)
  local raw = redis.call('HGET', accounts, accountId)
  local index = raw and cjson.decode(raw) or {ids = {}, expiresAt = 0}
  if type(index.ids) ~= 'table' or not tonumber(index.expiresAt) then error('Invalid Redis session account index') end
  for _, id in ipairs(index.ids) do
    if type(id) ~= 'string' then error('Invalid Redis session account index') end
  end
  return index
end
if mode == 'create' then
  if redis.call('HEXISTS', records, input.id) == 1 or redis.call('HEXISTS', digests, input.digest) == 1 then
    return redis.error_reply('Session IDs and digests must be unique')
  end
  if tonumber(input.absoluteExpiresAt) <= now then return redis.error_reply('Cannot create an expired session') end
  local index = accountIndex(input.accountId)
  local ids = {}
  for _, id in ipairs(index.ids) do
    local existing = load(id)
    if existing then
      if existing.accountId ~= input.accountId then return redis.error_reply('Invalid Redis session account index') end
      table.insert(ids, id)
    end
  end
  table.insert(ids, input.id)
  index.ids = ids
  index.expiresAt = string.format('%.0f', math.max(tonumber(index.expiresAt), tonumber(input.absoluteExpiresAt)))
  save(input)
  redis.call('HSET', digests, input.digest, input.id)
  expire(digests, input.digest, input.absoluteExpiresAt)
  redis.call('HSET', accounts, input.accountId, cjson.encode(index))
  expire(accounts, input.accountId, index.expiresAt)
  return cjson.encode(input)
elseif mode == 'find' then
  local id = redis.call('HGET', digests, input.digest)
  local session = id and load(id)
  return session and cjson.encode(session) or false
elseif mode == 'touch' or mode == 'revoke' then
  local session = load(input.id)
  if not session or session.revokedAt then return false end
  if mode == 'touch' then
    if tonumber(session.idleExpiresAt) <= input.now or tonumber(session.absoluteExpiresAt) <= input.now
        or tonumber(session.idleExpiresAt) <= now or tonumber(session.absoluteExpiresAt) <= now then return false end
    -- Concurrent older requests cannot shorten the activity or expiration watermark.
    session.lastSeenAt = string.format('%.0f', math.max(tonumber(session.lastSeenAt), input.lastSeenAt))
    session.idleExpiresAt = string.format('%.0f', math.min(tonumber(session.absoluteExpiresAt), math.max(tonumber(session.idleExpiresAt), input.idleExpiresAt)))
  else
    session.revokedAt = string.format('%.0f', input.revokedAt)
    session.revokeReason = input.reason
  end
  save(session)
  if mode == 'revoke' then return 1 end
  return cjson.encode(session)
end
local index = accountIndex(input.accountId)
local sessions = {}
-- Preload before revoking so a malformed record cannot cause partial revocation.
for _, id in ipairs(index.ids) do
  local session = load(id)
  if session then
    if session.accountId ~= input.accountId then return redis.error_reply('Invalid Redis session account index') end
    table.insert(sessions, session)
  end
end
if mode == 'list' then
  table.sort(sessions, function(a, b)
    if tonumber(a.createdAt) == tonumber(b.createdAt) then return a.id < b.id end
    return tonumber(a.createdAt) > tonumber(b.createdAt)
  end)
  if #sessions == 0 then return '[]' end
  return cjson.encode(sessions)
end
local count = 0
for _, session in ipairs(sessions) do
  if not session.revokedAt then
    session.revokedAt = string.format('%.0f', input.revokedAt)
    session.revokeReason = input.reason
    save(session)
    count = count + 1
  end
end
return count
`;
