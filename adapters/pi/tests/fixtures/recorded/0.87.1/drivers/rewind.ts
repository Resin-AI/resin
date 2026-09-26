export default function (pi) {
  pi.registerCommand("rewind", {
    description: "Rewind the active branch to an entry",
    handler: async (args, ctx) => {
      await ctx.navigateTree(args.trim(), { summarize: true });
    },
  });
  pi.registerCommand("rewind-plain", {
    description: "Rewind the active branch to an entry without a summary",
    handler: async (args, ctx) => {
      await ctx.navigateTree(args.trim(), { summarize: false });
    },
  });
}
