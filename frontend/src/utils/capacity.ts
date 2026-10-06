/**
 * 换热站容量校核计算（纯函数，不触碰数据库与 UI）
 *
 * 规则：
 * - 校核口径由站设计流量决定：楼栋分摊流量 = 站设计流量 × 该楼建筑面积 ÷
 *   参与分摊楼栋的面积合计；再与该楼阀门设计流量合计比较。
 * - 阀门设计流量作为现场参数原样保留并求和，绝不反向改写站设计流量。
 * - 不参与分摊：站设计流量为空（≤0 或非有限值）→ 整站不校核；
 *   建筑面积为零 → 该楼不参与；该楼没有阀门 → 该楼不参与。
 */
import type { Building } from '@/types/building'
import type { Station } from '@/types/station'
import type { Valve } from '@/types/valve'
import type { BuildingCapacityCheck, CapacityStatus, StationCapacityCheck } from '@/types/capacity'
import { round } from '@/utils/balance'

/** 超配判定容差（m³/h）：差值 ≤ 0.05 视为匹配，吸收一位小数取整噪声 */
export const CAPACITY_TOLERANCE_M3H = 0.05

/** 容量结论 → TDesign Tag 主题 */
export const CAPACITY_TAG_THEME: Record<CapacityStatus, 'danger' | 'primary' | 'success'> = {
  超配: 'danger',
  低配: 'primary',
  匹配: 'success'
}

/** 容量结论 → 文案色 */
export const CAPACITY_TEXT_COLOR: Record<CapacityStatus, string> = {
  超配: '#c0392b',
  低配: '#2b6cb0',
  匹配: '#1e8449'
}

/** 站设计流量是否为空（空则整站不校核） */
export function isStationFlowAvailable(designFlowM3h: number): boolean {
  return Number.isFinite(designFlowM3h) && designFlowM3h > 0
}

/** 按阀门合计与分摊额之差判定超配 / 低配 / 匹配 */
export function capacityStatusOf(excessM3h: number): CapacityStatus {
  if (excessM3h > CAPACITY_TOLERANCE_M3H) return '超配'
  if (excessM3h < -CAPACITY_TOLERANCE_M3H) return '低配'
  return '匹配'
}

/** 超配率（%）：超差额相对分摊额（或站设计流量），分母无效时为 0 */
export function excessPct(excessM3h: number, baselineM3h: number): number {
  if (!Number.isFinite(baselineM3h) || baselineM3h <= 0) return 0
  return round((excessM3h / baselineM3h) * 100, 1)
}

/** 汇总单座换热站的容量校核结果（纯函数，数据变更后由调用方重新计算） */
export function checkStationCapacity(
  station: Station,
  stationBuildings: Building[],
  stationValves: Valve[]
): StationCapacityCheck & { rows: BuildingCapacityCheck[] } {
  const stationValveTotalM3h = round(
    stationValves.reduce((sum, valve) => sum + (Number.isFinite(valve.designFlowM3h) ? valve.designFlowM3h : 0), 0),
    1
  )
  const stationValveCount = stationValves.length

  const valvesByBuilding = new Map<string, Valve[]>()
  stationValves.forEach((valve) => {
    const list = valvesByBuilding.get(valve.buildingId)
    if (list) list.push(valve)
    else valvesByBuilding.set(valve.buildingId, [valve])
  })

  const rows = stationBuildings.map((building) => {
    const ownValves = valvesByBuilding.get(building.id) ?? []
    const valveTotalM3h = round(
      ownValves.reduce((sum, valve) => sum + (Number.isFinite(valve.designFlowM3h) ? valve.designFlowM3h : 0), 0),
      1
    )
    return {
      buildingId: building.id,
      buildingName: building.name,
      areaM2: building.areaM2,
      valveCount: ownValves.length,
      valveTotalM3h,
      participating: false,
      skipReason: '',
      areaSharePct: 0,
      allocatedFlowM3h: 0,
      excessM3h: 0,
      status: null as CapacityStatus | null
    }
  })

  // 整站校核口径为空：所有楼栋一律不参与，原因写明
  if (!isStationFlowAvailable(station.designFlowM3h)) {
    const reason = '站设计流量为空，无法确定校核口径'
    rows.forEach((row) => {
      row.skipReason = reason
    })
    return {
      stationId: station.id,
      stationName: station.name,
      designFlowM3h: station.designFlowM3h,
      checkable: false,
      skipReason: reason,
      buildingCount: rows.length,
      participatingBuildingCount: 0,
      skippedBuildingCount: rows.length,
      participatingAreaM2: 0,
      stationValveCount,
      stationValveTotalM3h,
      stationExcessM3h: 0,
      status: null,
      overBuildingCount: 0,
      lowBuildingCount: 0,
      rows
    }
  }

  // 逐楼判定是否参与分摊并写明原因
  rows.forEach((row) => {
    if (!(Number.isFinite(row.areaM2) && row.areaM2 > 0)) {
      row.skipReason = '建筑面积为零，不参与分摊'
      return
    }
    if (row.valveCount === 0) {
      row.skipReason = '该楼没有阀门，不参与分摊'
    }
  })

  const participating = rows.filter((row) => row.skipReason === '')
  const participatingAreaM2 = participating.reduce((sum, row) => sum + row.areaM2, 0)

  if (participatingAreaM2 <= 0) {
    return {
      stationId: station.id,
      stationName: station.name,
      designFlowM3h: station.designFlowM3h,
      checkable: false,
      skipReason: '站内没有建筑面积大于零且已登记阀门的楼栋，无法按面积分摊',
      buildingCount: rows.length,
      participatingBuildingCount: 0,
      skippedBuildingCount: rows.length,
      participatingAreaM2: 0,
      stationValveCount,
      stationValveTotalM3h,
      stationExcessM3h: 0,
      status: null,
      overBuildingCount: 0,
      lowBuildingCount: 0,
      rows
    }
  }

  // 按建筑面积占比分摊站设计流量，再与阀门合计比较
  participating.forEach((row) => {
    row.participating = true
    row.areaSharePct = round((row.areaM2 / participatingAreaM2) * 100, 2)
    row.allocatedFlowM3h = round((station.designFlowM3h * row.areaM2) / participatingAreaM2, 1)
    row.excessM3h = round(row.valveTotalM3h - row.allocatedFlowM3h, 1)
    row.status = capacityStatusOf(row.valveTotalM3h - (station.designFlowM3h * row.areaM2) / participatingAreaM2)
  })

  const stationExcessM3h = round(stationValveTotalM3h - station.designFlowM3h, 1)

  return {
    stationId: station.id,
    stationName: station.name,
    designFlowM3h: station.designFlowM3h,
    checkable: true,
    skipReason: '',
    buildingCount: rows.length,
    participatingBuildingCount: participating.length,
    skippedBuildingCount: rows.length - participating.length,
    participatingAreaM2,
    stationValveCount,
    stationValveTotalM3h,
    stationExcessM3h,
    status: capacityStatusOf(stationValveTotalM3h - station.designFlowM3h),
    overBuildingCount: rows.filter((row) => row.status === '超配').length,
    lowBuildingCount: rows.filter((row) => row.status === '低配').length,
    rows
  }
}
