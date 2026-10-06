<script setup lang="ts">
/**
 * /stations 换热站与楼栋台账
 * 新建换热站与楼栋，按供热方式与面积区间筛选，卡片回显失衡楼栋数与待复核单数。
 * 消费 Station、Building；复用 <StatBadge>、<EmptyPanel>、<FilterBar>。
 */
import { computed, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { MessagePlugin, DialogPlugin } from 'tdesign-vue-next'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import FilterBar from '@/components/common/FilterBar.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import { useStationStore } from '@/stores/stationStore'
import { useValveStore } from '@/stores/valveStore'
import { useAdjustStore } from '@/stores/adjustStore'
import { useImbalanceRank } from '@/hooks/useImbalanceRank'
import { useCapacityCheck } from '@/hooks/useCapacityCheck'
import {
  CAPACITY_MATCH_EPS,
  type BuildingCapacityRow,
  type BuildingCapacityStatus,
  type StationCapacityReport,
  type StationCapacityStatus
} from '@/utils/capacity'
import {
  EMPTY_BUILDING_DRAFT,
  HEAT_MODES,
  type Building,
  type BuildingDraft,
  type HeatMode
} from '@/types/building'
import { EMPTY_STATION_DRAFT, formatArea, formatFlow, type Station, type StationDraft } from '@/types/station'

type FilterModel = { keyword: string; [key: string]: string | string[] | boolean }

const router = useRouter()
const stationStore = useStationStore()
const valveStore = useValveStore()
const adjustStore = useAdjustStore()
const rank = useImbalanceRank()
const capacity = useCapacityCheck()

/* ------------------------------ 派生 ------------------------------ */

const valveCountOf = (stationId: string): number =>
  valveStore.valves.filter((valve) => valve.stationId === stationId).length

const imbalancedCountOf = (stationId: string): number =>
  rank.rows.value.filter((row) => row.valve.stationId === stationId && row.level !== '平衡').length

const pendingReviewOf = (stationId: string): number =>
  adjustStore.adjusts.filter((adjust) => {
    if (adjust.state === '已复核') return false
    const valve = valveStore.valves.find((item) => item.id === adjust.valveId)
    return valve ? valve.stationId === stationId : false
  }).length

/* ---------------------------- 容量校核派生 ---------------------------- */

const currentCapacity = computed<StationCapacityReport | null>(() =>
  stationStore.currentStationId ? capacity.reportOf(stationStore.currentStationId) : null
)

const BUILDING_CAPACITY_THEME: Record<BuildingCapacityStatus, 'success' | 'danger' | 'primary' | 'default'> = {
  匹配: 'success',
  超配: 'danger',
  余量: 'primary',
  不参与: 'default'
}

const STATION_CAPACITY_THEME: Record<StationCapacityStatus, 'success' | 'danger' | 'primary' | 'warning'> = {
  匹配: 'success',
  超配: 'danger',
  余量: 'primary',
  不校核: 'warning'
}

function diffColor(diff: number | null): string | undefined {
  if (diff === null) return undefined
  if (diff > CAPACITY_MATCH_EPS) return '#c0392b'
  if (diff < -CAPACITY_MATCH_EPS) return '#2b6cb0'
  return undefined
}

function formatSignedFlow(diff: number | null): string {
  if (diff === null) return '—'
  const sign = diff > 0 ? '+' : ''
  return `${sign}${diff.toFixed(1)} m³/h`
}

function formatSignedPct(diff: number | null): string {
  if (diff === null) return '—'
  const sign = diff > 0 ? '+' : ''
  return `${sign}${diff.toFixed(1)}%`
}

const capacityColumns = [
  { colKey: 'name', title: '楼栋', width: 130 },
  { colKey: 'area', title: '建筑面积', width: 110 },
  { colKey: 'areaShare', title: '面积占比', width: 90 },
  { colKey: 'valves', title: '阀门(只)', width: 80 },
  { colKey: 'valveFlow', title: '阀门设计合计', width: 120 },
  { colKey: 'allocated', title: '站值分摊', width: 110 },
  { colKey: 'diff', title: '超配差值', width: 110 },
  { colKey: 'diffPct', title: '超配比例', width: 100 },
  { colKey: 'status', title: '校核结论', width: 200 }
]

function capacityRowKey(row: BuildingCapacityRow): string {
  return row.building.id
}

const stationColumns = [
  { colKey: 'name', title: '楼栋', width: 140 },
  { colKey: 'area', title: '建筑面积', width: 120, cell: 'areaCell' },
  { colKey: 'floors', title: '层数', width: 80 },
  { colKey: 'units', title: '单元数', width: 90 },
  { colKey: 'heatMode', title: '供热方式', width: 110, cell: 'heatModeCell' },
  { colKey: 'valveCount', title: '阀门数', width: 90, cell: 'valveCountCell' },
  { colKey: 'op', title: '操作', width: 220, cell: 'opCell' }
]

function stationRowKey(row: Building): string {
  return row.id
}

/* ------------------------------ 筛选 ------------------------------ */

const filterModel = computed<FilterModel>(() => ({
  keyword: stationStore.keyword,
  heatMode: stationStore.heatModes
}))

const filterSelects = computed(() => [
  { key: 'heatMode', label: '供热方式', options: HEAT_MODES.map((item) => ({ label: item, value: item })) }
])

function onFilterChange(model: FilterModel): void {
  stationStore.keyword = String(model.keyword ?? '')
  stationStore.setHeatModes((Array.isArray(model.heatMode) ? model.heatMode : []) as HeatMode[])
}

const areaInput = reactive<{ from: number | null; to: number | null }>({
  from: stationStore.areaFrom,
  to: stationStore.areaTo
})

function applyAreaRange(): void {
  stationStore.setAreaRange(areaInput.from, areaInput.to)
}

/* ---------------------------- 换热站表单 ---------------------------- */

const stationDialogVisible = ref(false)
const stationDialogTitle = ref('新建换热站')
const stationForm = reactive<StationDraft>({ ...EMPTY_STATION_DRAFT })
const stationFormRef = ref()
let editingStationId: string | null = null

const stationRules = {
  name: [{ required: true, message: '请填写换热站名称', type: 'error' as const }],
  heatAreaM2: [{ required: true, message: '请填写供热面积', type: 'error' as const }],
  designFlowM3h: [{ required: true, message: '请填写设计流量', type: 'error' as const }]
}

function openCreateStation(): void {
  editingStationId = null
  stationDialogTitle.value = '新建换热站'
  Object.assign(stationForm, { ...EMPTY_STATION_DRAFT })
  stationDialogVisible.value = true
}

function openEditStation(station: Station): void {
  editingStationId = station.id
  stationDialogTitle.value = `编辑换热站 · ${station.name}`
  Object.assign(stationForm, {
    name: station.name,
    heatAreaM2: station.heatAreaM2,
    designFlowM3h: station.designFlowM3h,
    supplyTempC: station.supplyTempC,
    returnTempC: station.returnTempC,
    commissionYear: station.commissionYear
  })
  stationDialogVisible.value = true
}

async function submitStation(): Promise<void> {
  try {
    const result = await stationFormRef.value?.validate()
    if (result !== true) return
  } catch {
    return
  }
  if (editingStationId) {
    await stationStore.updateStation(editingStationId, { ...stationForm })
    MessagePlugin.success('换热站已更新')
  } else {
    await stationStore.createStation({ ...stationForm })
    MessagePlugin.success('换热站已创建，可继续登记楼栋')
  }
  stationDialogVisible.value = false
}

function removeStation(station: Station): void {
  const dialog = DialogPlugin.confirm({
    header: '删除确认',
    body: `删除换热站「${station.name}」将同时删除其下楼栋、阀门、实测与调节单，确认删除？`,
    confirmBtn: '确认删除',
    cancelBtn: '取消',
    onConfirm: async () => {
      await stationStore.removeStation(station.id)
      MessagePlugin.success('换热站及其下游数据已删除')
      dialog.destroy()
    }
  })
}

/* ----------------------------- 楼栋表单 ----------------------------- */

const buildingDialogVisible = ref(false)
const buildingDialogTitle = ref('登记楼栋')
const buildingForm = reactive<BuildingDraft>({ ...EMPTY_BUILDING_DRAFT })
const buildingFormRef = ref()
let editingBuildingId: string | null = null

const buildingRules = {
  name: [{ required: true, message: '请填写楼栋名称', type: 'error' as const }],
  areaM2: [{ required: true, message: '请填写建筑面积', type: 'error' as const }]
}

function openCreateBuilding(): void {
  if (!stationStore.currentStationId) {
    MessagePlugin.warning('请先选择或新建一个换热站')
    return
  }
  editingBuildingId = null
  buildingDialogTitle.value = `登记楼栋 · ${stationStore.currentStation?.name ?? ''}`
  Object.assign(buildingForm, { ...EMPTY_BUILDING_DRAFT, stationId: stationStore.currentStationId })
  buildingDialogVisible.value = true
}

function openEditBuilding(building: Building): void {
  editingBuildingId = building.id
  buildingDialogTitle.value = `编辑楼栋 · ${building.name}`
  Object.assign(buildingForm, {
    stationId: building.stationId,
    name: building.name,
    areaM2: building.areaM2,
    floors: building.floors,
    units: building.units,
    heatMode: building.heatMode
  })
  buildingDialogVisible.value = true
}

async function submitBuilding(): Promise<void> {
  try {
    const result = await buildingFormRef.value?.validate()
    if (result !== true) return
  } catch {
    return
  }
  if (editingBuildingId) {
    await stationStore.updateBuilding(editingBuildingId, { ...buildingForm })
    MessagePlugin.success('楼栋已更新')
  } else {
    await stationStore.createBuilding({ ...buildingForm })
    MessagePlugin.success('楼栋已登记')
  }
  buildingDialogVisible.value = false
}

function removeBuilding(building: Building): void {
  const dialog = DialogPlugin.confirm({
    header: '删除确认',
    body: `删除楼栋「${building.name}」将同时删除其阀门与实测记录，确认删除？`,
    confirmBtn: '确认删除',
    cancelBtn: '取消',
    onConfirm: async () => {
      await stationStore.removeBuilding(building.id)
      MessagePlugin.success('楼栋及其下游数据已删除')
      dialog.destroy()
    }
  })
}

/* ------------------------------ 跳转 ------------------------------ */

function goValves(stationId: string): void {
  valveStore.patchFilter({ stationId, keyword: '' })
  void router.push('/valves')
}
</script>

<template>
  <div>
    <div class="page-head">
      <div>
        <h2 class="page-head__title">换热站与楼栋台账</h2>
        <p class="page-head__desc">
          先建换热站再登记楼栋；卡片回显失衡楼栋数与待复核调节单数，两侧联动切换。
        </p>
      </div>
      <div class="page-head__actions">
        <t-button theme="primary" @click="openCreateStation">新建换热站</t-button>
        <t-button variant="outline" :disabled="!stationStore.currentStationId" @click="openCreateBuilding">
          登记楼栋
        </t-button>
      </div>
    </div>

    <div class="stat-row">
      <StatBadge label="换热站" :value="stationStore.stations.length" suffix="座" tone="primary" />
      <StatBadge label="楼栋" :value="stationStore.buildings.length" suffix="栋" tone="info" />
      <StatBadge label="阀门" :value="valveStore.valves.length" suffix="只" tone="default" />
      <StatBadge
        label="容量超配站"
        :value="capacity.overStationCount.value"
        suffix="座"
        tone="danger"
      />
      <StatBadge
        label="严重失衡占比"
        :value="rank.summary.value.severe"
        :percent="rank.summary.value.severePercent"
        suffix="只"
        tone="danger"
      />
    </div>

    <FilterBar
      :model-value="filterModel"
      :selects="filterSelects"
      keyword-placeholder="搜索换热站 / 楼栋名称"
      @change="onFilterChange"
    />

    <div class="grid-two" style="margin-top: 16px">
      <div class="panel">
        <h3 class="panel-title">换热站列表（{{ stationStore.filteredStations.length }}）</h3>
        <EmptyPanel
          v-if="stationStore.filteredStations.length === 0"
          title="还没有换热站"
          description="新建换热站后即可登记楼栋与阀门。"
          action-text="新建换热站"
          compact
          @action="openCreateStation"
        />
        <div
          v-for="station in stationStore.filteredStations"
          :key="station.id"
          class="card-list-item"
          :class="{ 'is-active': station.id === stationStore.currentStationId }"
          @click="stationStore.selectStation(station.id)"
        >
          <div class="card-list-item__head">
            <span>{{ station.name }}</span>
            <span class="toolbar" style="gap: 4px">
              <t-tag
                v-if="capacity.reportOf(station.id)?.status === '超配'"
                size="small"
                theme="danger"
                variant="light"
              >
                容量超配
              </t-tag>
              <t-tag size="small" variant="light" theme="primary">{{ station.commissionYear }} 年投运</t-tag>
            </span>
          </div>
          <div class="card-list-item__meta">
            <span>{{ formatArea(station.heatAreaM2) }}</span>
            <span>· 设计 {{ formatFlow(station.designFlowM3h) }}</span>
            <span>· {{ station.supplyTempC }}/{{ station.returnTempC }} ℃</span>
          </div>
          <div class="card-list-item__meta">
            <span>楼栋 {{ stationStore.buildingsOf(station.id).length }}</span>
            <span>· 阀门 {{ valveCountOf(station.id) }}</span>
            <span :style="{ color: imbalancedCountOf(station.id) > 0 ? '#c0392b' : undefined }">
              · 失衡 {{ imbalancedCountOf(station.id) }}
            </span>
            <span>· 待复核 {{ pendingReviewOf(station.id) }}</span>
          </div>
          <div class="card-list-item__meta" style="gap: 8px">
            <t-button size="small" variant="text" theme="primary" @click.stop="openEditStation(station)">
              编辑
            </t-button>
            <t-button size="small" variant="text" theme="danger" @click.stop="removeStation(station)">删除</t-button>
            <t-button size="small" variant="text" theme="primary" @click.stop="goValves(station.id)">
              该站阀门
            </t-button>
          </div>
        </div>
      </div>

      <div class="panel">
        <div class="panel-head">
          <h3 class="panel-title" style="margin: 0">
            楼栋明细
            <span v-if="stationStore.currentStation" class="muted">· {{ stationStore.currentStation.name }}</span>
          </h3>
          <div class="toolbar">
            <t-input-number
              v-model="areaInput.from"
              :min="0"
              :step="500"
              placeholder="面积起"
              style="width: 128px"
              @blur="applyAreaRange"
            />
            <span class="muted">～</span>
            <t-input-number
              v-model="areaInput.to"
              :min="0"
              :step="500"
              placeholder="面积止"
              style="width: 128px"
              @blur="applyAreaRange"
            />
            <t-button size="small" variant="outline" @click="stationStore.resetFilter(); areaInput.from = null; areaInput.to = null">
              重置筛选
            </t-button>
          </div>
        </div>

        <EmptyPanel
          v-if="stationStore.filteredBuildings.length === 0"
          title="该条件下没有楼栋"
          description="调整供热方式或面积区间，或直接登记一栋新楼栋。"
          action-text="登记楼栋"
          compact
          @action="openCreateBuilding"
        />

        <t-table
          v-else
          :data="stationStore.filteredBuildings"
          :columns="stationColumns"
          :row-key="stationRowKey"
          bordered
          stripe
          size="small"
        >
          <template #areaCell="{ row }">{{ formatArea(row.areaM2) }}</template>
          <template #heatModeCell="{ row }">
            <t-tag size="small" :theme="row.heatMode === '地暖' ? 'success' : 'warning'" variant="light">
              {{ row.heatMode }}
            </t-tag>
          </template>
          <template #valveCountCell="{ row }">
            {{ valveStore.valves.filter((valve) => valve.buildingId === row.id).length }}
          </template>
          <template #opCell="{ row }">
            <div class="toolbar">
              <t-button size="small" variant="text" theme="primary" @click="openEditBuilding(row)">编辑</t-button>
              <t-button size="small" variant="text" theme="danger" @click="removeBuilding(row)">删除</t-button>
              <t-button size="small" variant="text" theme="primary" @click="goValves(row.stationId)">阀门</t-button>
            </div>
          </template>
        </t-table>
      </div>
    </div>

    <div class="panel capacity-panel">
      <div class="panel-head">
        <h3 class="panel-title" style="margin: 0">
          容量校核
          <span v-if="stationStore.currentStation" class="muted">· {{ stationStore.currentStation.name }}</span>
          <t-tag
            v-if="currentCapacity"
            size="small"
            :theme="STATION_CAPACITY_THEME[currentCapacity.status]"
            variant="light"
            style="margin-left: 8px"
          >
            整站{{ currentCapacity.status }}
          </t-tag>
        </h3>
        <span class="muted">
          校核口径：站设计流量按建筑面积占比分摊到楼，再与该楼阀门设计流量合计比较；阀门原设计流量只读保留
        </span>
      </div>

      <EmptyPanel
        v-if="!currentCapacity"
        title="请先选择换热站"
        description="在左侧选择一座换热站后，按楼栋面积占比分摊站设计流量并校核阀门合计。"
        compact
      />

      <template v-else>
        <t-alert
          v-if="currentCapacity.status === '不校核'"
          theme="warning"
          :message="currentCapacity.skipReason ?? '该站不参与容量校核'"
          style="margin-bottom: 12px"
        />

        <div class="capacity-summary">
          <div class="capacity-summary__item">
            <span class="muted">站设计流量（校核上限）</span>
            <strong>{{ formatFlow(currentCapacity.stationDesignFlow) }}</strong>
          </div>
          <div class="capacity-summary__item">
            <span class="muted">参与楼栋阀门设计合计</span>
            <strong :style="{ color: diffColor(currentCapacity.stationFlowDiff) }">
              {{ currentCapacity.status === '不校核' ? '—' : formatFlow(currentCapacity.participatingValveFlow) }}
            </strong>
          </div>
          <div class="capacity-summary__item">
            <span class="muted">合计差值 / 比例</span>
            <strong :style="{ color: diffColor(currentCapacity.stationFlowDiff) }">
              {{ formatSignedFlow(currentCapacity.stationFlowDiff) }}
              <em class="muted">（{{ formatSignedPct(currentCapacity.stationDiffPct) }}）</em>
            </strong>
          </div>
          <div class="capacity-summary__item">
            <span class="muted">分摊面积 / 楼栋</span>
            <strong>
              {{ formatArea(currentCapacity.participatingArea) }}
              <em class="muted">· {{ currentCapacity.participatingCount }} 栋参与 / {{ currentCapacity.skippedCount }} 栋不参与</em>
            </strong>
          </div>
          <div class="capacity-summary__item">
            <span class="muted">超配楼栋</span>
            <strong :style="{ color: currentCapacity.overCount > 0 ? '#c0392b' : undefined }">
              {{ currentCapacity.overCount }} 栋
            </strong>
          </div>
        </div>

        <t-table
          :data="currentCapacity.rows"
          :columns="capacityColumns"
          :row-key="capacityRowKey"
          bordered
          stripe
          size="small"
        >
          <template #areaCell="{ row }">{{ formatArea(row.building.areaM2) }}</template>
          <template #areaShareCell="{ row }">{{ row.participating ? `${row.areaSharePct.toFixed(1)}%` : '—' }}</template>
          <template #valvesCell="{ row }">{{ row.valveCount }}</template>
          <template #valveFlowCell="{ row }">{{ formatFlow(row.valveFlowTotal) }}</template>
          <template #allocatedCell="{ row }">
            {{ row.allocatedFlow === null ? '—' : formatFlow(row.allocatedFlow) }}
          </template>
          <template #diffCell="{ row }">
            <span :style="{ color: diffColor(row.flowDiff) }">{{ formatSignedFlow(row.flowDiff) }}</span>
          </template>
          <template #diffPctCell="{ row }">
            <span :style="{ color: diffColor(row.flowDiff) }">{{ formatSignedPct(row.diffPct) }}</span>
          </template>
          <template #statusCell="{ row }">
            <span class="toolbar">
              <t-tag size="small" :theme="BUILDING_CAPACITY_THEME[row.status as BuildingCapacityStatus]" :variant="row.status === '不参与' ? 'outline' : 'light'">
                {{ row.status }}
              </t-tag>
              <span v-if="row.skipReason" class="muted">{{ row.skipReason }}</span>
            </span>
          </template>
        </t-table>
      </template>
    </div>

    <t-dialog
      v-model:visible="stationDialogVisible"
      :header="stationDialogTitle"
      width="560px"
      :confirm-btn="'保存'"
      :cancel-btn="'取消'"
      @confirm="submitStation"
    >
      <t-form ref="stationFormRef" :data="stationForm" :rules="stationRules" label-width="128px">
        <t-form-item label="换热站名称" name="name">
          <t-input v-model="stationForm.name" placeholder="如 阳光家园换热站" />
        </t-form-item>
        <t-form-item label="供热面积(m²)" name="heatAreaM2">
          <t-input-number v-model="stationForm.heatAreaM2" :min="0" :step="1000" style="width: 100%" />
        </t-form-item>
        <t-form-item label="设计流量(m³/h)" name="designFlowM3h">
          <t-input-number v-model="stationForm.designFlowM3h" :min="0" :step="10" style="width: 100%" />
        </t-form-item>
        <t-form-item label="设计供水温度" name="supplyTempC">
          <t-input-number v-model="stationForm.supplyTempC" :min="0" :step="1" style="width: 100%" />
        </t-form-item>
        <t-form-item label="设计回水温度" name="returnTempC">
          <t-input-number v-model="stationForm.returnTempC" :min="0" :step="1" style="width: 100%" />
        </t-form-item>
        <t-form-item label="投运年份" name="commissionYear">
          <t-input-number v-model="stationForm.commissionYear" :min="1980" :max="2100" style="width: 100%" />
        </t-form-item>
      </t-form>
    </t-dialog>

    <t-dialog
      v-model:visible="buildingDialogVisible"
      :header="buildingDialogTitle"
      width="560px"
      :confirm-btn="'保存'"
      :cancel-btn="'取消'"
      @confirm="submitBuilding"
    >
      <t-form ref="buildingFormRef" :data="buildingForm" :rules="buildingRules" label-width="128px">
        <t-form-item label="所属换热站">
          <t-input :value="stationStore.currentStation ? stationStore.currentStation.name : ''" disabled />
        </t-form-item>
        <t-form-item label="楼栋名称" name="name">
          <t-input v-model="buildingForm.name" placeholder="如 3号楼 / A座" />
        </t-form-item>
        <t-form-item label="建筑面积(m²)" name="areaM2">
          <t-input-number v-model="buildingForm.areaM2" :min="0" :step="100" style="width: 100%" />
        </t-form-item>
        <t-form-item label="层数" name="floors">
          <t-input-number v-model="buildingForm.floors" :min="1" style="width: 100%" />
        </t-form-item>
        <t-form-item label="单元数" name="units">
          <t-input-number v-model="buildingForm.units" :min="1" style="width: 100%" />
        </t-form-item>
        <t-form-item label="供热方式" name="heatMode">
          <t-radio-group v-model="buildingForm.heatMode" variant="default-filled">
            <t-radio-button v-for="item in HEAT_MODES" :key="item" :value="item">{{ item }}</t-radio-button>
          </t-radio-group>
        </t-form-item>
      </t-form>
    </t-dialog>
  </div>
</template>

<style scoped>
.capacity-panel {
  margin-top: 16px;
}

.capacity-summary {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-bottom: 12px;
}

.capacity-summary__item {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 180px;
  padding: 10px 12px;
  border: 1px solid var(--hg-line);
  border-radius: 10px;
  background: #fff;
  font-size: 13px;
}

.capacity-summary__item strong {
  font-size: 16px;
  font-weight: 700;
  color: var(--hg-ink);
  font-variant-numeric: tabular-nums;
}
</style>
