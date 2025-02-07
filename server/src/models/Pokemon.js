/* eslint-disable no-restricted-syntax */
const { Model, raw, ref } = require('objection')
const Ohbem = require('ohbem')
const { pokemon: masterfile } = require('../data/masterfile.json')
const legacyFilter = require('../services/legacyFilter')
const {
  api: { pvp: { minCp: pvpMinCp, leagues, reactMapHandlesPvp, levels }, queryLimits },
} = require('../services/config')
const dbSelection = require('../services/functions/dbSelection')
const getAreaSql = require('../services/functions/getAreaSql')

const { type: dbType } = dbSelection('pokemon')
const levelCalc = 'IFNULL(IF(cp_multiplier < 0.734, ROUND(58.35178527 * cp_multiplier * cp_multiplier - 2.838007664 * cp_multiplier + 0.8539209906), ROUND(171.0112688 * cp_multiplier - 95.20425243)), NULL)'
const ivCalc = 'IFNULL((individual_attack + individual_defense + individual_stamina) / 0.45, NULL)'
const keys = ['iv', 'level', 'atk_iv', 'def_iv', 'sta_iv', ...leagues.map(league => league.name)]
const madKeys = {
  iv: raw(ivCalc),
  level: raw(levelCalc),
  atk_iv: 'individual_attack',
  def_iv: 'individual_defense',
  sta_iv: 'individual_stamina',
}
let ohbem = null

const getMadSql = q => (
  q.leftJoin('trs_spawn', 'pokemon.spawnpoint_id', 'trs_spawn.spawnpoint')
    .leftJoin('pokemon_display', 'pokemon.encounter_id', 'pokemon_display.encounter_id')
    .select([
      '*',
      ref('pokemon.encounter_id')
        .castTo('CHAR')
        .as('id'),
      'pokemon.latitude AS lat',
      'pokemon.longitude AS lon',
      'individual_attack AS atk_iv',
      'individual_defense AS def_iv',
      'individual_stamina AS sta_iv',
      'height AS size',
      'pokemon.form',
      'pokemon.gender',
      'pokemon.costume',
      'pokemon_display.pokemon AS display_pokemon_id',
      'pokemon_display.form AS ditto_form',
      'weather_boosted_condition AS weather',
      raw('IF(calc_endminsec, 1, NULL)')
        .as('expire_timestamp_verified'),
      raw('Unix_timestamp(disappear_time)')
        .as('expire_timestamp'),
      raw('Unix_timestamp(last_modified)')
        .as('updated'),
      raw(ivCalc)
        .as('iv'),
      raw(levelCalc)
        .as('level'),
    ])
)

module.exports = class Pokemon extends Model {
  static get tableName() {
    return 'pokemon'
  }

  static get idColumn() {
    return dbSelection('pokemon').type === 'mad'
      ? 'encounter_id' : 'id'
  }

  static async initOhbem() {
    const leagueObj = Object.fromEntries(leagues.map(league => [league.name, league.cp]))
    const hasLittle = leagues.find(league => league.name === 'little')
    if (hasLittle) {
      leagueObj.little = hasLittle.littleCupRules ? 500 : { little: false, cap: 500 }
    }
    ohbem = new Ohbem({
      leagues: leagueObj,
      pokemonData: await Ohbem.fetchPokemonData(),
      levelCaps: levels,
      cachingStrategy: Ohbem.cachingStrategies.memoryHeavy,
    })
  }

  static async getPokemon(args, perms, isMad) {
    const {
      iv: ivs, pvp, areaRestrictions,
    } = perms
    const {
      onlyStandard, onlyIvOr, onlyXlKarp, onlyXsRat, onlyZeroIv, onlyHundoIv, onlyPvpMega, onlyLinkGlobal, ts,
    } = args.filters
    let queryPvp = false
    const safeTs = ts || Math.floor((new Date()).getTime() / 1000)

    // quick check to make sure no Pokemon are returned when none are enabled for users with only Pokemon perms
    if (!ivs && !pvp) {
      const noPokemonSelect = Object.keys(args.filters).find(x => x.charAt(0) !== 'o')
      if (!noPokemonSelect) return []
    }

    const pvpCheck = (pkmn, league, min, max) => {
      const rankCheck = pkmn.rank <= max && pkmn.rank >= min
      const cpCheck = dbType === 'chuck' || reactMapHandlesPvp || pkmn.cp >= pvpMinCp[league]
      const megaCheck = !pkmn.evolution || onlyPvpMega
      const capCheck = dbType === 'chuck' || reactMapHandlesPvp ? pkmn.capped || args.filters[`onlyPvp${pkmn.cap}`] : true
      return rankCheck && cpCheck && megaCheck && capCheck
    }

    const getRanks = (league, data, filterId) => {
      const [min, max] = getMinMax(filterId, league)
      let best = 4096
      const filtered = data.filter(pkmn => {
        if (pkmn.rank < best) best = pkmn.rank
        return pvpCheck(pkmn, league, min, max)
      })
      return { filtered, best }
    }

    // decide if the Pokemon passes global or local filter
    const getMinMax = (filterId, league) => {
      const globalOn = !arrayCheck(onlyIvOr, league)
      const specificFilter = args.filters[filterId]
      const [globalMin, globalMax] = onlyIvOr[league]
      let min = 0
      let max = 0
      if (specificFilter && !arrayCheck(specificFilter, league)) {
        const [pkmnMin, pkmnMax] = specificFilter[league]
        if (globalOn) {
          min = pkmnMin <= globalMin ? pkmnMin : globalMin
          max = pkmnMax >= globalMax ? pkmnMax : globalMax
        } else {
          min = pkmnMin
          max = pkmnMax
        }
      } else if (globalOn) {
        min = globalMin
        max = globalMax
      }
      return [min, max]
    }

    // parse PVP JSON(s)
    const getParsedPvp = (pokemon) => {
      if (dbType === 'chuck') {
        return JSON.parse(pokemon.pvp)
      }
      const parsed = {}
      const pvpKeys = ['great', 'ultra']
      pvpKeys.forEach(league => {
        if (pokemon[`pvp_rankings_${league}_league`]) {
          parsed[league] = JSON.parse(pokemon[`pvp_rankings_${league}_league`])
        }
      })
      return parsed
    }

    // checks if filters are set to default and skips them if so
    const arrayCheck = (filter, key) => filter[key].every((v, i) => v === onlyStandard[key][i])

    // cycles through the above arrayCheck
    const getRelevantKeys = filter => {
      const relevantKeys = []
      keys.forEach(key => {
        if (!arrayCheck(filter, key)) {
          relevantKeys.push(key)
        }
      })
      return relevantKeys
    }

    // generates specific SQL for each slider that isn't set to default, along with perm checks
    const generateSql = (queryBase, filter, relevant) => {
      relevant.forEach(key => {
        switch (key) {
          default:
            if (pvp) {
              queryPvp = true
              if (!relevant.includes('iv')
                && !relevant.includes('level')
                && !relevant.includes('atk_iv')
                && !relevant.includes('def_iv')
                && !relevant.includes('sta_iv')) {
                // doesn't return everything if only pvp stats for individual pokemon
                queryBase.whereNull('pokemon_id')
              }
            } break
          case 'level':
          case 'atk_iv':
          case 'def_iv':
          case 'sta_iv':
          case 'iv':
            if (ivs) {
              queryBase.andWhereBetween(isMad ? madKeys[key] : key, filter[key])
            } break
        }
      })
    }

    const globalCheck = (pkmn) => onlyLinkGlobal ? args.filters[`${pkmn.pokemon_id}-${pkmn.form}`] : true

    const handleDitto = (pkmn) => {
      pkmn.ditto_form = pkmn.form
      pkmn.form = masterfile[pkmn.pokemon_id].defaultFormId
      const statsToCheck = ['atk', 'def', 'sta']
      statsToCheck.forEach(stat => {
        if (!pkmn[`${stat}_iv`] && pkmn[`${stat}_inactive`]) {
          pkmn[`${stat}_iv`] = pkmn[`${stat}_inactive`]
          pkmn.inactive_stats = true
        }
      })
    }
    // query builder
    const query = this.query()
    if (isMad) {
      getMadSql(query)
    }
    query.where(isMad ? 'disappear_time' : 'expire_timestamp', '>=', isMad ? this.knex().fn.now() : safeTs)
      .andWhereBetween(isMad ? 'pokemon.latitude' : 'lat', [args.minLat, args.maxLat])
      .andWhereBetween(isMad ? 'pokemon.longitude' : 'lon', [args.minLon, args.maxLon])
      .andWhere(ivOr => {
        for (const [pkmn, filter] of Object.entries(args.filters)) {
          if (pkmn.includes('-')) {
            const relevantFilters = getRelevantKeys(filter)
            const [id, form] = pkmn.split('-')
            ivOr.orWhere(poke => {
              if (id === '132') {
                poke.where('pokemon_id', id)
              } else {
                poke.where('pokemon_id', id)
                  .andWhere('pokemon.form', form)
              }
              if (relevantFilters.length) {
                generateSql(poke, filter, relevantFilters, true)
              }
            })
          } else if (pkmn === 'onlyIvOr' && (ivs || pvp)) {
            const relevantFilters = getRelevantKeys(filter)
            if (relevantFilters.length) {
              generateSql(ivOr, filter, relevantFilters)
            } else {
              ivOr.whereNull('pokemon_id')
            }
          }
        }
        if (onlyXlKarp) {
          ivOr.orWhere('pokemon_id', 129)
            .andWhere('weight', '>=', 13.125)
        }
        if (onlyXsRat) {
          ivOr.orWhere('pokemon_id', 19)
            .andWhere('weight', '<=', 2.40625)
        }
        if (onlyZeroIv && ivs) {
          ivOr.orWhere(isMad ? raw(ivCalc) : 'iv', 0)
        }
        if (onlyHundoIv && ivs) {
          ivOr.orWhere(isMad ? raw(ivCalc) : 'iv', 100)
        }
      })
    if (areaRestrictions?.length) {
      getAreaSql(query, areaRestrictions, isMad, 'pokemon')
    }

    const results = await query.limit(queryLimits.pokemon)
    const finalResults = []
    const pvpResults = []
    const listOfIds = []

    // form checker
    results.forEach(pkmn => {
      let noPvp = true
      if (pkmn.pokemon_id === 132 && !pkmn.ditto_form) {
        handleDitto(pkmn)
      }
      if (!pkmn.seen_type) {
        if (pkmn.spawn_id === null) {
          pkmn.seen_type = pkmn.pokestop_id ? 'nearby_stop' : 'nearby_cell'
        } else {
          pkmn.seen_type = 'encounter'
        }
      }
      if (pvp && ((pkmn.pvp_rankings_great_league
        || pkmn.pvp_rankings_ultra_league
        || pkmn.pvp)
        || (dbType === 'mad' && reactMapHandlesPvp && pkmn.cp))) {
        noPvp = false
        listOfIds.push(pkmn.id)
        pvpResults.push(pkmn)
      }
      if (noPvp && globalCheck(pkmn)) {
        finalResults.push(pkmn)
      }
    })

    // second query for pvp
    if (queryPvp && (dbType !== 'mad' || reactMapHandlesPvp)) {
      const pvpQuery = this.query()
      if (isMad) {
        getMadSql(pvpQuery)
        pvpQuery.select(raw(true).as('pvpCheck'))
      } else {
        pvpQuery.select(['*', raw(true).as('pvpCheck')])
      }
      pvpQuery.where(isMad ? 'disappear_time' : 'expire_timestamp', '>=', isMad ? this.knex().fn.now() : safeTs)
        .andWhereBetween(isMad ? 'pokemon.latitude' : 'lat', [args.minLat, args.maxLat])
        .andWhereBetween(isMad ? 'pokemon.longitude' : 'lon', [args.minLon, args.maxLon])
      if (isMad && listOfIds.length) {
        pvpQuery.whereRaw(`pokemon.encounter_id NOT IN ( ${listOfIds.join(',')} )`)
      } else {
        pvpQuery.whereNotIn('id', listOfIds)
      }
      if (reactMapHandlesPvp) {
        pvpQuery.whereNotNull('cp')
      } else if (dbType === 'chuck') {
        pvpQuery.whereNotNull('pvp')
      } else {
        pvpQuery.andWhere(pvpBuilder => {
          pvpBuilder.whereNotNull('pvp_rankings_great_league')
            .orWhereNotNull('pvp_rankings_ultra_league')
        })
      }
      if (areaRestrictions?.length) {
        getAreaSql(pvpQuery, areaRestrictions, isMad, 'pokemon')
      }
      pvpResults.push(...await pvpQuery.limit(queryLimits.pokemonPvp - results.length))
    }

    // filter pokes with pvp data
    pvpResults.forEach(pkmn => {
      const parsed = reactMapHandlesPvp ? this.getOhbemPvp(pkmn) : getParsedPvp(pkmn)
      const filterId = `${pkmn.pokemon_id}-${pkmn.form}`
      pkmn.cleanPvp = {}
      pkmn.bestPvp = 4096
      if (pkmn.pokemon_id === 132 && !pkmn.ditto_form && pkmn.pvpCheck) {
        handleDitto(pkmn)
      }
      if (!pkmn.seen_type) pkmn.seen_type = 'encounter'
      Object.keys(parsed).forEach(league => {
        const { filtered, best } = getRanks(league, parsed[league], filterId)
        if (filtered.length) {
          pkmn.cleanPvp[league] = filtered
          if (best < pkmn.bestPvp) pkmn.bestPvp = best
        }
      })
      if ((Object.keys(pkmn.cleanPvp).length || !pkmn.pvpCheck) && globalCheck(pkmn)) {
        finalResults.push(pkmn)
      }
    })
    return finalResults
  }

  static getOhbemPvp(pokemon) {
    try {
      return ohbem.queryPvPRank(
        pokemon.pokemon_id,
        pokemon.form,
        pokemon.costume,
        pokemon.gender,
        pokemon.atk_iv,
        pokemon.def_iv,
        pokemon.sta_iv,
        pokemon.level,
      )
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('Unable to process PVP Stats for Pokemon with ID#: ', pokemon.id, '\n', e.message)
      return {}
    }
  }

  static async getLegacy(args, perms, isMad) {
    const ts = Math.floor((new Date()).getTime() / 1000)
    const query = this.query()
      .where(isMad ? 'disappear_time' : 'expire_timestamp', '>=', isMad ? this.knex().fn.now() : ts)
      .andWhereBetween(isMad ? 'pokemon.latitude' : 'lat', [args.minLat, args.maxLat])
      .andWhereBetween(isMad ? 'pokemon.longitude' : 'lon', [args.minLon, args.maxLon])
    if (isMad) {
      getMadSql(query)
    }
    if (perms.areaRestrictions?.length) {
      getAreaSql(query, perms.areaRestrictions, isMad, 'pokemon')
    }
    const results = await query
    return legacyFilter(results, args, perms, ohbem)
  }

  static async getAvailablePokemon(isMad) {
    const ts = Math.floor((new Date()).getTime() / 1000)
    const results = await this.query()
      .select('pokemon_id', 'form')
      .where(isMad ? 'disappear_time' : 'expire_timestamp', '>=', isMad ? this.knex().fn.now() : ts)
      .groupBy('pokemon_id', 'form')
      .orderBy('pokemon_id', 'form')
    return results.map(pkmn => `${pkmn.pokemon_id}-${pkmn.form}`)
  }
}
