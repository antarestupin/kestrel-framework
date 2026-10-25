/** Fixed keys keep record, digest and subject indexes in the same atomic boundary. */
export const tokenScript = `
local expected = {'hash', 'hash', 'zset', 'zset', 'zset'}
for i, kind in ipairs(expected) do
  local actual = redis.call('TYPE', KEYS[i]).ok
  if actual ~= 'none' and actual ~= kind then return redis.error_reply('Invalid Redis adapter key type') end
end
local mode = ARGV[1]
local input = cjson.decode(ARGV[2])
local records, digests, subjects, expires, inactive = KEYS[1], KEYS[2], KEYS[3], KEYS[4], KEYS[5]
local function load(id)
  local raw = redis.call('HGET', records, id)
  if not raw then return nil end
  local token = cjson.decode(raw)
  if token.version ~= 1 or token.id ~= id or type(token.digest) ~= 'string'
      or type(token.definition) ~= 'string' or not tonumber(token.expiresAt) then
    error('Invalid Redis token record')
  end
  return token
end
local function subjectIds(field)
  local prefix = field .. string.char(0)
  local members = redis.call('ZRANGEBYLEX', subjects, '[' .. prefix, '[' .. prefix .. string.char(255))
  local ids = {}
  for _, member in ipairs(members) do table.insert(ids, string.sub(member, #prefix + 1)) end
  return ids
end
local function save(token)
  redis.call('HSET', records, token.id, cjson.encode(token))
  local at = token.consumedAt or token.revokedAt
  if token.consumedAt and token.revokedAt then at = math.min(tonumber(token.consumedAt), tonumber(token.revokedAt)) end
  if at then redis.call('ZADD', inactive, string.format('%.0f', tonumber(at)), token.id) end
end
local function valid(token)
  return token and token.definition == input.definition and tonumber(token.expiresAt) > input.now
    and not token.consumedAt and not token.revokedAt
end
if mode == 'create' then
  local staged, indexes = {}, {}
  -- Preflight the complete batch, including records affected by subject replacement.
  for _, token in ipairs(input) do
    if redis.call('HEXISTS', records, token.id) == 1 or redis.call('HEXISTS', digests, token.digest) == 1 then
      return redis.error_reply('Stored token IDs and digests must be unique')
    end
    if token.subjectIndex then
      local added = indexes[token.subjectIndex] or {}
      indexes[token.subjectIndex] = added
      if token.replaceExistingForSubject then
        local ids = subjectIds(token.subjectIndex)
        for _, id in ipairs(added) do table.insert(ids, id) end
        for _, id in ipairs(ids) do
          local existing = staged[id] or load(id)
          if existing and not existing.consumedAt and not existing.revokedAt then
            existing.revokedAt = token.createdAt
            staged[id] = existing
          end
        end
      end
      table.insert(added, token.id)
    end
    staged[token.id] = token
  end
  for _, token in pairs(staged) do save(token) end
  for _, token in ipairs(input) do
    redis.call('HSET', digests, token.digest, token.id)
    redis.call('ZADD', expires, token.expiresAt, token.id)
    if token.subjectIndex then redis.call('ZADD', subjects, 0, token.subjectIndex .. string.char(0) .. token.id) end
  end
  return 1
elseif mode == 'find' or mode == 'consume' or mode == 'revoke' then
  local id = redis.call('HGET', digests, input.digest)
  local token = id and load(id)
  if not valid(token) then return false end
  if mode == 'consume' then token.consumedAt = string.format('%.0f', input.now); save(token) end
  if mode == 'revoke' then token.revokedAt = string.format('%.0f', input.revokedAt); save(token); return 1 end
  return cjson.encode(token)
end
local candidates = {}
if mode == 'revokeSubject' or mode == 'deleteSubject' then
  for _, id in ipairs(subjectIds(input.subjectIndex)) do
    local token = load(id)
    if token then
      if token.subjectIndex ~= input.subjectIndex then return redis.error_reply('Invalid Redis token subject index') end
      if mode == 'deleteSubject' or (tonumber(token.expiresAt) > input.now and not token.consumedAt and not token.revokedAt) then
        table.insert(candidates, token)
      end
    end
  end
elseif mode == 'prune' then
  local seen = {}
  -- Bound both index reads and removals, without scanning unrelated token records.
  for _, index in ipairs({{expires, input.expiredBefore}, {inactive, input.inactiveBefore}}) do
    local ids = redis.call('ZRANGEBYSCORE', index[1], '-inf', index[2], 'LIMIT', 0, input.limit)
    for _, id in ipairs(ids) do
      if not seen[id] and #candidates < input.limit then
        seen[id] = true
        local token = load(id)
        if token then table.insert(candidates, token) end
      end
    end
  end
end
for _, token in ipairs(candidates) do
  if mode == 'revokeSubject' then
    token.revokedAt = string.format('%.0f', input.now)
    save(token)
  else
    redis.call('HDEL', records, token.id)
    redis.call('HDEL', digests, token.digest)
    redis.call('ZREM', expires, token.id)
    redis.call('ZREM', inactive, token.id)
    if token.subjectIndex then redis.call('ZREM', subjects, token.subjectIndex .. string.char(0) .. token.id) end
  end
end
return #candidates
`;
