export async function mapWithConcurrency<T, R>(
    items: T[],
    concurrency: number,
    worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
    if (items.length === 0) return []

    const results = new Array<R>(items.length)
    const workerCount = Math.max(1, Math.min(concurrency, items.length))
    let nextIndex = 0

    const runners = Array.from({length: workerCount}, async () => {
        while (true) {
            const currentIndex = nextIndex
            nextIndex += 1
            if (currentIndex >= items.length) return
            results[currentIndex] = await worker(items[currentIndex], currentIndex)
        }
    })

    await Promise.all(runners)
    return results
}
