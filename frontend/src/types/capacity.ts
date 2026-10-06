/**
 * 换热站容量校核类型
 *
 * 校核口径由换热站设计流量决定：按参与分摊楼栋的建筑面积占比，把站设计
 * 流量分摊到各楼栋，再与该楼现有阀门设计流量合计比较。阀门设计流量是
 * 现场参数，只原样参与求和，不得反向覆盖站设计流量，否则站能力失去上限。
 */

/** 容量校核结论：超配 = 阀门合计高于分摊额；低配 = 低于分摊额 */
export type CapacityStatus = '超配' | '低配' | '匹配'

/** 单栋楼的容量校核结果 */
export interface BuildingCapacityCheck {
  buildingId: string
  buildingName: string
  /** 建筑面积（m²） */
  areaM2: number
  /** 该楼下阀门数（含设计流量为 0 的阀门） */
  valveCount: number
  /** 该楼现有阀门设计流量合计（m³/h），现场参数原样求和 */
  valveTotalM3h: number
  /** 是否参与分摊 */
  participating: boolean
  /** 不参与分摊时的书面原因；参与时为空串 */
  skipReason: string
  /** 建筑面积占参与分摊面积合计的比例（%），不参与为 0 */
  areaSharePct: number
  /** 按站设计流量分摊到该楼的流量（m³/h），不参与为 0 */
  allocatedFlowM3h: number
  /** 阀门合计 − 分摊额（m³/h），不参与为 0 */
  excessM3h: number
  /** 校核结论；不参与分摊时为 null */
  status: CapacityStatus | null
}

/** 单座换热站的容量校核结果 */
export interface StationCapacityCheck {
  stationId: string
  stationName: string
  /** 站设计流量（m³/h），本次校核口径 */
  designFlowM3h: number
  /** 站设计流量有效且存在可分摊楼栋时才可校核 */
  checkable: boolean
  /** 整站不可校核时的书面原因；可校核时为空串 */
  skipReason: string
  buildingCount: number
  participatingBuildingCount: number
  skippedBuildingCount: number
  /** 参与分摊楼栋的建筑面积合计（m²） */
  participatingAreaM2: number
  /** 站内阀门总数（含未参与分摊楼栋下的阀门） */
  stationValveCount: number
  /** 站内阀门设计流量合计（m³/h，全量口径） */
  stationValveTotalM3h: number
  /** 阀门合计 − 站设计流量（m³/h），不可校核为 0 */
  stationExcessM3h: number
  /** 整站结论；不可校核时为 null */
  status: CapacityStatus | null
  overBuildingCount: number
  lowBuildingCount: number
  rows: BuildingCapacityCheck[]
}
