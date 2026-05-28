// 固定容量环形缓冲：MVP 用最小实现
// 元素按 seq 单调递增；溢出时丢弃最老一条

export class RingBuffer<T extends { seq: number }> {
    private readonly items: T[] = []
    private readonly capacity: number

    constructor(capacity: number) {
        this.capacity = Math.max(1, capacity | 0)
    }

    push(item: T): void {
        this.items.push(item)
        const excess = this.items.length - this.capacity
        if (excess > 0) this.items.splice(0, excess)
    }

    // 取 seq > sinceSeq 的全部，按 seq 升序
    sliceAfter(sinceSeq: number): T[] {
        for (let i = 0; i < this.items.length; i += 1) {
            if (this.items[i].seq > sinceSeq) return this.items.slice(i)
        }
        return []
    }

    // 从尾向前找首个满足 predicate 的元素；用于 status() 找最近 progress 帧
    findLast(predicate: (item: T) => boolean): T | undefined {
        for (let i = this.items.length - 1; i >= 0; i -= 1) {
            if (predicate(this.items[i])) return this.items[i]
        }
        return undefined
    }

    size(): number {
        return this.items.length
    }

    firstSeq(): number {
        return this.items.length === 0 ? 0 : this.items[0].seq
    }

    lastSeq(): number {
        return this.items.length === 0 ? 0 : this.items[this.items.length - 1].seq
    }
}
