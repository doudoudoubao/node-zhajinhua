# 零依赖项目，使用官方精简镜像即可
FROM node:22-alpine

WORKDIR /app

# 仅复制运行所需文件
COPY package.json ./
COPY server.js ./
COPY src ./src
COPY public ./public

ENV PORT=25500
ENV HOST=0.0.0.0
# 联机用户数据持久化目录（建议挂载为数据卷）
ENV ZJH_DATA_DIR=/app/data
VOLUME /app/data
EXPOSE 25500

# 健康检查
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:25500/health || exit 1

CMD ["node", "server.js"]
