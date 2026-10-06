/**
 * 换热站容量校核
 *
 * 校核口径由换热站设计流量决定：站设计流量按楼栋建筑面积占比分摊到
 * 参与分摊的楼栋，再与该楼现有阀门设计流量合计比较。阀门设计流量是
 * 现场登记参数，校核只读不写，绝不用阀门合计反推覆盖站设计流量。
 *
 * 不参与分摊的情形（写明原因）：
 * - 站设计流量为空（0 / 非有限值）：整站不校核，下楼栋统一记「站设计流量为空」
 * - 楼栋建筑面积为零：记「建筑面积为零」
 * - 楼栋没有阀门：记「楼栋没有阀门」
 */
import type { Building } from '@/types/building'
import type { Valve } from '@/types/valve'
import type { Station } from '@/types/station'

/** 分摊/差值统一保留 1 位小数（m³/h） */
export const FLOW_STEP = 0.1
/** 小于该差值（m³/h）视为匹配，避免 0.1 取整误差误报 */
export const CAPACITY_MATCH_EPS = 0.05

/** 单栋楼的容量校核状态 */
export type BuildingCapacityStatus = '匹配' | '超配' | '余量' | '不参与'

/** 整站的容量校核状态 */
export type StationCapacityStatus = '匹配' | '超配' | '余量' | '不校核'

export const SKIP_REASON = {
  stationFlowEmpty: '站设计流量为空，不参与分摊',
  areaZero: '建筑面积为零，不参与分摊',
  noValve: '楼栋没有阀门，不参与分摊'
} as const

export interface BuildingCapacityRow {
  building: Building
  /** 该楼现有阀门设计流量合计（现场参数原样求和，未参与分摊时同样展示） */
  valveFlowTotal: number
  valveCount: number
  /** 建筑面积在参与分摊面积中的占比（%），不参与时为 0 */
  areaSharePct: number
  /** 按面积占比分摊到的站设计流量；不参与分摊时为 null */
  allocatedFlow: number | null
  /** 阀门合计 − 分摊流量；不参与分摊时为 null */
  flowDiff: number | null
  /** (阀门合计 ÷ 分摊流量 − 1) × 100%；不参与分摊时为 null */
  diffPct: number | null
  status: BuildingCapacityStatus
  participating: boolean
  skipReason: string | null
}

export interface StationCapacityReport {
  station: Station
  stationDesignFlow: number
  /** 参与分摊楼栋的面积合计 */
  participatingArea: number
  /** 参与分摊楼栋数 */
  participatingCount: number
  /** 不参与分摊楼栋数 */
  skippedCount: number
  /** 参与分摊楼栋的阀门设计流量合计 */
  participatingValveFlow: number
  /** 参与分摊楼栋的分摊流量合计（按 0.1 取整修正后与站设计流量一致） */
  allocatedTotal: number
  /** 参与楼栋阀门合计 − 站设计流量；整站不校核时为 null */
  stationFlowDiff: number | null
  stationDiffPct: number | null
  overCount: number
  status: StationCapacityStatus
  skipReason: string | null
  rows: BuildingCapacityRow[]
}

function positive(value: number): boolean {
  return Number.isFinite(value) && value > 0
}

export function buildingStatusOf(flowDiff: number): BuildingCapacityStatus {
  if (flowDiff > CAPACITY_MATCH_EPS) return '超配'
  if (flowDiff < -CAPACITY_MATCH_EPS) return '余量'
  return '匹配'
}

export function stationStatusOf(flowDiff: number): StationCapacityStatus {
  if (flowDiff > CAPACITY_MATCH_EPS) return '超配'
  if (flowDiff < -CAPACITY_MATCH_EPS) return '余量'
  return '匹配'
}

/**
 * 按面积占比把总量分摊为 len(weights) 份，每份按 0.1 取整；
 * 用最大余数法修正末份，保证各份合计与总量（0.1 精度）严格相等。
 */
export function allocateByArea(total: number, weights: number[]): number[] {
  if (weights.length === 0) return []
  const weightSum = weights.reduce((sum, item) => sum + item, 0)
  if (!positive(weightSum)) return weights.map(() => 0)

  const raw = weights.map((weight) => (total * weight) / weightSum)
  const rounded = raw.map((value) => Math.round(value * 10) / 10)
  const target = Math.round(total * 10) / 10
  const remainder = Math.round((target - rounded.reduce((sum, item) => sum + item, 0)) * 10) / 10
  if (remainder !== 0) {
    // 余数为正时补到取整少得最多的份额，为负时从取整多得最多的份额扣
    let index = 0
    let bestGap = -Infinity
    rounded.forEach((value, i) => {
      const gap = remainder > 0 ? raw[i] - value : value - raw[i]
      if (gap > bestGap) {
        bestGap = gap
        index = i
      }
    })
    rounded[index] = Math.round((rounded[index] + remainder) * 10) / 10
  }
  return rounded
}

/**
 * 单站容量校核：站设计流量按参与楼栋的建筑面积占比分摊，
 * 再与各楼阀门设计流量合计比较。
 */
export function buildStationCapacityReport(
  station: Station,
  buildings: Building[],
  valves: Valve[]
): StationCapacityReport {
  const stationFlow = station.designFlowM3h
  const stationFlowValid = positive(stationFlow)

  const valvesByBuilding = new Map<string, Valve[]>()
  valves.forEach((valve) => {
    const list = valvesByBuilding.get(valve.buildingId)
    if (list) list.push(valve)
    else valvesByBuilding.set(valve.buildingId, [valve])
  })

  const ordered = [...buildings].sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))

  const isParticipant = (building: Building, ownValves: Valve[] | undefined): boolean =>
    stationFlowValid && positive(building.areaM2) && (ownValves?.length ?? 0) > 0

  const participantArea = ordered.reduce(
    (sum, building) => sum + (isParticipant(building, valvesByBuilding.get(building.id)) ? building.areaM2 : 0),
    0
  )
  const participantBuildings = ordered.filter((building) =>
    isParticipant(building, valvesByBuilding.get(building.id))
  )
  const allocated = allocateByArea(
    stationFlow,
    participantBuildings.map((building) => building.areaM2)
  )
  const allocatedByBuilding = new Map(
    participantBuildings.map((building, index) => [building.id, allocated[index] ?? 0])
  )

  const rows: BuildingCapacityRow[] = ordered.map((building) => {
    const ownValves = valvesByBuilding.get(building.id) ?? []
    const valveFlowTotal = ownValves.reduce((sum, valve) => sum + valve.designFlowM3h, 0)

    if (!stationFlowValid) {
      return {
        building,
        valveFlowTotal,
        valveCount: ownValves.length,
        areaSharePct: 0,
        allocatedFlow: null,
        flowDiff: null,
        diffPct: null,
        status: '不参与',
        participating: false,
        skipReason: SKIP_REASON.stationFlowEmpty
      }
    }
    if (!positive(building.areaM2)) {
      return {
        building,
        valveFlowTotal,
        valveCount: ownValves.length,
        areaSharePct: 0,
        allocatedFlow: null,
        flowDiff: null,
        diffPct: null,
        status: '不参与',
        participating: false,
        skipReason: SKIP_REASON.areaZero
      }
    }
    if (ownValves.length === 0) {
      return {
        building,
        valveFlowTotal,
        valveCount: 0,
        areaSharePct: 0,
        allocatedFlow: null,
        flowDiff: null,
        diffPct: null,
        status: '不参与',
        participating: false,
        skipReason: SKIP_REASON.noValve
      }
    }

    const allocatedFlow = allocatedByBuilding.get(building.id) ?? 0
    const flowDiff = Math.round((valveFlowTotal - allocatedFlow) * 10) / 10
    const diffPct = positive(allocatedFlow)
      ? Math.round(((valveFlowTotal - allocatedFlow) / allocatedFlow) * 1000) / 10
      : 0
    return {
      building,
      valveFlowTotal,
      valveCount: ownValves.length,
      areaSharePct: Math.round((building.areaM2 / participantArea) * 1000) / 10,
      allocatedFlow,
      flowDiff,
      diffPct,
      status: buildingStatusOf(flowDiff),
      participating: true,
      skipReason: null
    }
  })

  const participatingValveFlow = rows
    .filter((row) => row.participating)
    .reduce((sum, row) => sum + row.valveFlowTotal, 0)
  const allocatedTotal = allocated.reduce((sum, item) => sum + item, 0)
  const overCount = rows.filter((row) => row.status === '超配').length

  if (!stationFlowValid) {
    return {
      station,
      stationDesignFlow: stationFlow,
      participatingArea: 0,
      participatingCount: 0,
      skippedCount: rows.length,
      participatingValveFlow: 0,
      allocatedTotal: 0,
      stationFlowDiff: null,
      stationDiffPct: null,
      overCount: 0,
      status: '不校核',
      skipReason: SKIP_REASON.stationFlowEmpty,
      rows
    }
  }

  if (participantBuildings.length === 0) {
    return {
      station,
      stationDesignFlow: stationFlow,
      participatingArea: 0,
      participatingCount: 0,
      skippedCount: rows.length,
      participatingValveFlow: 0,
      allocatedTotal: 0,
      stationFlowDiff: null,
      stationDiffPct: null,
      overCount: 0,
      status: '不校核',
      skipReason: '没有可参与分摊的楼栋（建筑面积为零或楼栋没有阀门）',
      rows
    }
  }

  const stationFlowDiff = Math.round((participatingValveFlow - allocatedTotal) * 10) / 10
  const stationDiffPct =
    allocatedTotal > 0 ? Math.round((stationFlowDiff / allocatedTotal) * 1000) / 10 : 0

  return {
    station,
    stationDesignFlow: stationFlow,
    participatingArea: participantArea,
    participatingCount: participantBuildings.length,
    skippedCount: rows.length - participantBuildings.length,
    participatingValveFlow,
    allocatedTotal,
    stationFlowDiff,
    stationDiffPct,
    overCount,
    status: stationStatusOf(stationFlowDiff),
    skipReason: null,
    rows
  }
}

/** 整网逐站校核；阀门/楼栋以 building.stationId 为归属依据 */
export function buildAllStationCapacityReports(
  stations: Station[],
  buildings: Building[],
  valves: Valve[]
): Map<string, StationCapacityReport> {
  const buildingsByStation = new Map<string, Building[]>()
  const valvesByStation = new Map<string, Valve[]>()
  buildings.forEach((building) => {
    const list = buildingsByStation.get(building.stationId)
    if (list) list.push(building)
    else buildingsByStation.set(building.stationId, [building])
  })
  valves.forEach((valve) => {
    const list = valvesByStation.get(valve.stationId)
    if (list) list.push(valve)
    else valvesByStation.set(valve.stationId, [valve])
  })

  const result = new Map<string, StationCapacityReport>()
  stations
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
    .forEach((station) => {
      result.set(
        station.id,
        buildStationCapacityReport(
          station,
          buildingsByStation.get(station.id) ?? [],
          valvesByStation.get(station.id) ?? []
        )
      )
    })
  return result
}
