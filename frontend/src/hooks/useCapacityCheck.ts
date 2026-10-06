/**
 * 容量校核：基于换热站设计流量的面积占比分摊结果。
 * 数据来自 stationStore（站/楼栋）与 valveStore（阀门），均为 liveQuery
 * 响应式集合——面积调整、站设计流量修改、阀门增删改或楼栋归属变更后，
 * 整站分摊与超配提示自动同步重算，不需要额外持久化。
 * 被换热站台账页消费。
 */
import { computed, type ComputedRef } from 'vue'
import { useStationStore } from '@/stores/stationStore'
import { useValveStore } from '@/stores/valveStore'
import {
  buildAllStationCapacityReports,
  type StationCapacityReport
} from '@/utils/capacity'

export interface UseCapacityCheckResult {
  /** 全部换热站的校核报告，按站 id 索引 */
  reports: ComputedRef<Map<string, StationCapacityReport>>
  /** 阀门设计流量合计超过分摊能力的站数 */
  overStationCount: ComputedRef<number>
  reportOf: (stationId: string) => StationCapacityReport | null
}

export function useCapacityCheck(): UseCapacityCheckResult {
  const stationStore = useStationStore()
  const valveStore = useValveStore()

  const reports = computed<Map<string, StationCapacityReport>>(() =>
    buildAllStationCapacityReports(
      stationStore.stations,
      stationStore.buildings,
      valveStore.valves
    )
  )

  const overStationCount = computed(
    () => Array.from(reports.value.values()).filter((report) => report.status === '超配').length
  )

  const reportOf = (stationId: string): StationCapacityReport | null =>
    reports.value.get(stationId) ?? null

  return { reports, overStationCount, reportOf }
}
