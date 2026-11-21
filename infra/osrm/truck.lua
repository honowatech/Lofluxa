-- Profil OSRM « camion-citerne » de Tournéo, dérivé du profil voiture d'OSRM (car.lua).
--
-- Ce fichier doit être placé dans le même dossier que car.lua et lib/ (dans l'image : /opt).
-- Il réutilise tel quel le profil voiture de la version d'OSRM installée, puis :
--   * réduit les vitesses (coefficient + plafond), y compris sur les revêtements dégradés ;
--   * suit les restrictions d'accès propres aux poids lourds (hgv=no, goods=no, …) à la place de
--     celles des voitures, et les restrictions de manœuvre « restriction:hgv » ;
--   * écarte les voies interdites aux matières dangereuses (hazmat=no) ;
--   * applique le gabarit d'un camion (hauteur, largeur, longueur, poids) aux limites taguées
--     (maxheight, maxwidth, maxlength, maxweight) ;
--   * plafonne la vitesse à « maxspeed:hgv » quand la voie en porte une ;
--   * alourdit les pénalités de virage et de demi-tour.
--
-- Réglages (variables d'environnement lues au prétraitement, valeurs par défaut entre parenthèses) :
--   TRUCK_SPEED_FACTOR   coefficient appliqué aux vitesses du profil voiture (0.8)
--   TRUCK_MAX_SPEED_KMH  vitesse maximale d'un camion chargé, en km/h (80)
--   TRUCK_HEIGHT_M (4.0)  TRUCK_WIDTH_M (2.55)  TRUCK_LENGTH_M (16.5)  TRUCK_WEIGHT_KG (40000)
--   TRUCK_HAZMAT         1 = écarter les voies hazmat=no (1)

api_version = 4

local car = require('car')
local Sequence = require('lib/sequence')
local Measure = require('lib/measure')

local getenv = (os and os.getenv) or function() return nil end

local function number_setting(name, default, minimum, maximum)
  local value = tonumber(getenv(name) or '')
  if value == nil or value < minimum or value > maximum then
    return default
  end
  return value
end

local SPEED_FACTOR = number_setting('TRUCK_SPEED_FACTOR', 0.8, 0.3, 1.0)
local MAX_SPEED = number_setting('TRUCK_MAX_SPEED_KMH', 80, 20, 130)
local AVOID_HAZMAT = (getenv('TRUCK_HAZMAT') or '1') ~= '0'

-- Vitesse d'un camion pour une vitesse de voiture donnée (km/h, au moins 5).
local function truck_speed(car_speed)
  return math.max(5, math.min(MAX_SPEED, math.floor(car_speed * SPEED_FACTOR + 0.5)))
end

local function scale_speed_table(speeds)
  for key, value in pairs(speeds) do
    if type(value) == 'number' and value > 0 then
      speeds[key] = truck_speed(value)
    end
  end
end

local function setup()
  local profile = car.setup()

  profile.properties.max_speed_for_map_matching = (MAX_SPEED + 30) / 3.6
  profile.properties.u_turn_penalty = 90       -- demi-tour très coûteux pour un camion-citerne
  profile.turn_penalty = 15                    -- virages plus lents qu'en voiture (7,5 s)
  profile.default_speed = truck_speed(profile.default_speed)

  -- Gabarit du véhicule, comparé aux limites taguées sur les voies.
  profile.vehicle_height = number_setting('TRUCK_HEIGHT_M', 4.0, 2.0, 5.0)
  profile.vehicle_width = number_setting('TRUCK_WIDTH_M', 2.55, 1.8, 3.5)
  profile.vehicle_length = number_setting('TRUCK_LENGTH_M', 16.5, 5.0, 25.0)
  profile.vehicle_weight = number_setting('TRUCK_WEIGHT_KG', 40000, 3500, 80000)

  -- Restrictions d'accès : celles des poids lourds priment sur les restrictions générales.
  profile.access_tags_hierarchy = Sequence { 'hgv', 'goods', 'motor_vehicle', 'vehicle', 'access' }
  profile.restrictions = Sequence { 'hgv', 'motor_vehicle', 'vehicle' }
  profile.access_tag_whitelist['hgv'] = true
  profile.access_tag_whitelist['goods'] = true
  profile.access_tag_whitelist['motorcar'] = nil

  -- Vitesses réduites : par type de voie, par revêtement, par état de la chaussée.
  scale_speed_table(profile.speeds.highway)
  scale_speed_table(profile.surface_speeds)
  scale_speed_table(profile.tracktype_speeds)
  scale_speed_table(profile.smoothness_speeds)

  profile.truck = { max_speed = MAX_SPEED, avoid_hazmat = AVOID_HAZMAT }
  return profile
end

local function forbidden_for_hazmat(way)
  local hazmat = way:get_value_by_key('hazmat')
  if hazmat == 'no' then
    return true
  end
  -- Les carburants sont des matières polluantes pour l'eau.
  return way:get_value_by_key('hazmat:water') == 'no'
end

-- Ramène la vitesse d'un sens de circulation sous le plafond, en conservant les pénalités déjà appliquées.
local function cap_direction(profile, result, speed_key, rate_key, cap)
  local speed = result[speed_key]
  if speed and speed > cap then
    if profile.properties.weight_name == 'routability' and result[rate_key] and result[rate_key] > 0 then
      result[rate_key] = result[rate_key] * cap / speed
    end
    result[speed_key] = cap
  end
end

local function hgv_speed_limit(profile, way, direction)
  local raw = way:get_value_by_key('maxspeed:hgv:' .. direction) or way:get_value_by_key('maxspeed:hgv')
  local limit = raw and Measure.get_max_speed(raw)
  if limit and limit > 0 then
    return limit * profile.speed_reduction
  end
  return nil
end

local function process_way(profile, way, result, relations)
  if profile.truck.avoid_hazmat and forbidden_for_hazmat(way) then
    return -- voie interdite aux matières dangereuses : non routable
  end

  car.process_way(profile, way, result, relations)

  local forward_cap = math.min(profile.truck.max_speed, hgv_speed_limit(profile, way, 'forward') or math.huge)
  local backward_cap = math.min(profile.truck.max_speed, hgv_speed_limit(profile, way, 'backward') or math.huge)
  cap_direction(profile, result, 'forward_speed', 'forward_rate', forward_cap)
  cap_direction(profile, result, 'backward_speed', 'backward_rate', backward_cap)
end

return {
  setup = setup,
  process_way = process_way,
  process_node = car.process_node,
  process_turn = car.process_turn
}
