import type {DialogField} from './custom-dialog'

const COMMON_TAIL: DialogField[] = [
    {key: 'sortType', label: '排序方式', type: 'select', value: 'recent', options: [
        {value: 'recent', label: '时间排序'},
        {value: 'hot', label: '热度排序'}
    ]},
    {key: 'minLikeRate', label: '最低点赞率 (0~1)', type: 'number', value: 0.02, step: 0.01, min: 0, max: 1, group: '过滤条件'},
    {key: 'maxDurationSec', label: '最长视频时长（秒）', type: 'number', value: 60, step: 1, min: 1, group: '过滤条件'},
    {key: 'startDate', label: '起始日期', type: 'date'},
    {key: 'endDate', label: '截止日期', type: 'date'}
]

export const TK_BATCH_COLLECT_FIELDS: DialogField[] = [
    {key: 'batchSize', label: '采集博主数', type: 'number', value: 500, min: 1},
    {key: 'videoCount', label: '每博主视频数', type: 'number', value: 20, min: 1},
    ...COMMON_TAIL
]

export const TK_SINGLE_COLLECT_FIELDS: DialogField[] = [
    {key: 'videoCount', label: '视频数量', type: 'number', value: 20, min: 1},
    ...COMMON_TAIL
]
