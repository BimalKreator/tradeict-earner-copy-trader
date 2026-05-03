export async function logUserActivity(prisma, args) {
    try {
        await prisma.userActivity.create({
            data: {
                userId: args.userId,
                kind: args.kind,
                message: args.message.slice(0, 500),
            },
        });
    }
    catch (err) {
        console.warn("[userActivity] log failed:", err);
    }
}
//# sourceMappingURL=userActivityService.js.map