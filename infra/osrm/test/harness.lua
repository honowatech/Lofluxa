-- Banc d'essai hors OSRM : simule l'environnement Lua fourni par osrm-extract (v5.27) pour exécuter
-- car.lua et truck.lua sur des voies fictives. Usage : lua5.4 harness.lua <dossier profils voiture> <truck.lua>
local car_dir, truck_file = arg[1], arg[2]
package.path = car_dir .. '/?.lua;' .. package.path

-- Globales fournies par OSRM
mode = { inaccessible = 0, driving = 1, cycling = 2, walking = 3, ferry = 4, train = 5, pushing_bike = 6,
  steps_up = 8, steps_down = 9, river_up = 10, river_down = 11, route = 12 }
road_priority_class = setmetatable({}, { __index = function(_, k) return k end })
constants = { max_turn_weight = 2147483647, precision = 10 }
function canonicalizeStringList(s) return s end
function trimLaneString(s) return s end
function applyAccessTokens(s) return s end
function durationIsValid(s) return false end
function parseDuration(s) return 0 end

local function new_way(tags)
  return {
    get_value_by_key = function(_, key) return tags[key] end,
    get_location_tag = function() return nil end,
    id = function() return 1 end,
    version = function() return 1 end,
    get_nodes = function() return {} end,
  }
end

local function new_result()
  return { forward_mode = mode.inaccessible, backward_mode = mode.inaccessible, forward_speed = -1,
    backward_speed = -1, forward_rate = -1, backward_rate = -1, duration = -1, weight = -1,
    forward_classes = {}, backward_classes = {}, road_classification = {} }
end

local function load_profile(file)
  for _, name in ipairs({ 'car' }) do package.loaded[name] = nil end
  local chunk = assert(loadfile(file))
  local functions = chunk()
  return functions, functions.setup()
end

local function route(functions, profile, tags)
  local result = new_result()
  functions.process_way(profile, new_way(tags), result, {})
  local ok_f = result.forward_mode ~= mode.inaccessible and result.forward_speed > 0
  local ok_b = result.backward_mode ~= mode.inaccessible and result.backward_speed > 0
  return { forward = ok_f, backward = ok_b, routable = ok_f or ok_b, result = result }
end

local failures, checks = 0, 0
local function check(label, condition, detail)
  checks = checks + 1
  if condition then
    print('  ok    ' .. label)
  else
    failures = failures + 1
    print('  ÉCHEC ' .. label .. (detail and (' — ' .. tostring(detail)) or ''))
  end
end

local car_fn, car_profile = load_profile(car_dir .. '/car.lua')
package.path = (truck_file:match('^(.*)/[^/]*$') or '.') .. '/?.lua;' .. package.path
local truck_fn, truck_profile = load_profile(truck_file)

print('Structure du profil')
check('quatre fonctions exportées', type(truck_fn.setup) == 'function' and type(truck_fn.process_way) == 'function'
  and type(truck_fn.process_node) == 'function' and type(truck_fn.process_turn) == 'function')
check('api_version = 4', api_version == 4)
check('poids « routability » conservé', truck_profile.properties.weight_name == 'routability')
check('le profil voiture rechargé reste intact', car_profile.speeds.highway.trunk == 85)

print('Vitesses réduites')
local slower, capped = true, true
for kind, speed in pairs(car_profile.speeds.highway) do
  local t = truck_profile.speeds.highway[kind]
  if not (t and t <= speed and (t < speed or speed <= 5)) then slower = false; print('    ' .. kind, speed, t) end
  if t > 80 then capped = false end
end
check('chaque type de voie est plus lent que pour une voiture', slower)
check('aucune vitesse au-dessus de 80 km/h', capped)
for _, kind in ipairs({ 'motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential' }) do
  local c = route(car_fn, car_profile, { highway = kind }).result
  local t = route(truck_fn, truck_profile, { highway = kind }).result
  print(string.format('    %-13s voiture %3d km/h  camion %3d km/h', kind, c.forward_speed, t.forward_speed))
  check(kind .. ' : routable et plus lent', t.forward_speed > 0 and t.forward_speed < c.forward_speed and t.forward_rate > 0 and t.forward_rate < c.forward_rate)
end
local unpaved_car = route(car_fn, car_profile, { highway = 'primary', surface = 'unpaved' }).result
local unpaved = route(truck_fn, truck_profile, { highway = 'primary', surface = 'unpaved' }).result
check('piste non revêtue plus lente (voiture ' .. unpaved_car.forward_speed .. ', camion ' .. unpaved.forward_speed .. ')', unpaved.forward_speed < unpaved_car.forward_speed)
local fast = route(truck_fn, truck_profile, { highway = 'trunk', maxspeed = '110' }).result
check('maxspeed=110 plafonné à 80 km/h', fast.forward_speed == 80 and fast.backward_speed == 80, fast.forward_speed)
check('le poids suit la vitesse plafonnée', math.abs(fast.forward_rate - 80 / 3.6) < 0.01, fast.forward_rate)
local slow = route(truck_fn, truck_profile, { highway = 'trunk', maxspeed = '30' }).result
check('maxspeed=30 respecté (24 km/h après coefficient de réalisme)', math.abs(slow.forward_speed - 24) < 0.01, slow.forward_speed)
local hgv_limit = route(truck_fn, truck_profile, { highway = 'trunk', maxspeed = '90', ['maxspeed:hgv'] = '50' }).result
check('maxspeed:hgv=50 appliqué (40 km/h)', math.abs(hgv_limit.forward_speed - 40) < 0.01, hgv_limit.forward_speed)
check('maxspeed:hgv réduit aussi le poids', math.abs(hgv_limit.forward_rate - 40 / 3.6) < 0.01, hgv_limit.forward_rate)
local narrow_lane = route(truck_fn, truck_profile, { highway = 'trunk', maxspeed = '110', lanes = '1' }).result
check('pénalité de voie étroite conservée après plafonnement', math.abs(narrow_lane.forward_rate - 80 * 0.5 / 3.6) < 0.01, narrow_lane.forward_rate)

print('Voies interdites aux poids lourds')
local function both(tags) return route(car_fn, car_profile, tags), route(truck_fn, truck_profile, tags) end
local c, t = both({ highway = 'primary', hgv = 'no' })
check('hgv=no : voiture oui, camion non', c.routable and not t.routable)
c, t = both({ highway = 'primary', goods = 'no' })
check('goods=no : camion non', c.routable and not t.routable)
c, t = both({ highway = 'primary', motor_vehicle = 'no' })
check('motor_vehicle=no : ni voiture ni camion', not c.routable and not t.routable)
c, t = both({ highway = 'primary', access = 'no', hgv = 'yes' })
check('access=no + hgv=yes : camion oui', not c.routable and t.routable)
c, t = both({ highway = 'residential', motorcar = 'no' })
check('motorcar=no ne concerne pas les camions', not c.routable and t.routable)
c, t = both({ highway = 'primary', ['hgv:forward'] = 'no' })
check('hgv:forward=no : sens retour seulement', t.backward and not t.forward)
c, t = both({ highway = 'primary', hgv = 'destination' })
check('hgv=destination : desserte locale seulement (accès restreint)', t.routable and t.result.forward_restricted == true and not c.result.forward_restricted)
c, t = both({ highway = 'primary', hgv = 'designated' })
check('hgv=designated : camion oui', t.routable)
c, t = both({ highway = 'primary' })
check('voie sans restriction : voiture et camion', c.routable and t.routable)

print('Matières dangereuses')
c, t = both({ highway = 'trunk', hazmat = 'no' })
check('hazmat=no : voiture oui, camion-citerne non', c.routable and not t.routable)
c, t = both({ highway = 'trunk', ['hazmat:water'] = 'no' })
check('hazmat:water=no : camion-citerne non', c.routable and not t.routable)
c, t = both({ highway = 'trunk', hazmat = 'designated' })
check('hazmat=designated : camion-citerne oui', t.routable)

print('Gabarit')
c, t = both({ highway = 'primary', maxheight = '3.5' })
check('maxheight=3.5 : camion non', c.routable and not t.routable)
c, t = both({ highway = 'primary', maxheight = '4.5' })
check('maxheight=4.5 : camion oui', t.routable)
c, t = both({ highway = 'primary', maxweight = '20' })
check('maxweight=20 t : camion non', c.routable and not t.routable)
c, t = both({ highway = 'primary', maxweight = '44' })
check('maxweight=44 t : camion oui', t.routable)
c, t = both({ highway = 'primary', maxwidth = '2.3' })
check('maxwidth=2.3 : camion non', c.routable and not t.routable)
c, t = both({ highway = 'primary', maxlength = '10' })
check('maxlength=10 : camion non', c.routable and not t.routable)
c, t = both({ highway = 'primary', narrow = 'yes' })
check('narrow=yes : camion non', c.routable and not t.routable)

print('Cas hérités du profil voiture')
c, t = both({ highway = 'footway' })
check('chemin piéton : non routable', not c.routable and not t.routable)
c, t = both({ highway = 'primary', oneway = 'yes' })
check('sens unique respecté', t.forward and not t.backward)
c, t = both({ highway = 'construction' })
check('voie en travaux : non routable', not t.routable)
c, t = both({ building = 'yes' })
check('objet sans highway : ignoré', not t.routable)
check('pénalités de manœuvre alourdies', truck_profile.turn_penalty > car_profile.turn_penalty and truck_profile.properties.u_turn_penalty > car_profile.properties.u_turn_penalty)

print('Virages')
local turn = { angle = 90, number_of_roads = 3, is_u_turn = false, has_traffic_light = false, duration = 0, weight = 0,
  source_mode = mode.driving, target_mode = mode.driving, source_restricted = false, target_restricted = false, is_left_hand_driving = false }
local car_turn = {}; for k, v in pairs(turn) do car_turn[k] = v end
car_fn.process_turn(car_profile, car_turn); truck_fn.process_turn(truck_profile, turn)
check(string.format('virage à 90° plus coûteux (voiture %.1f s, camion %.1f s)', car_turn.duration, turn.duration), turn.duration > car_turn.duration)

print(string.format('%d contrôles, %d échec(s)', checks, failures))
os.exit(failures == 0 and 0 or 1)
