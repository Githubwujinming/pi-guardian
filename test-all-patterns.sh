#!/bin/bash
# 全面模式测试：逐一输出各种模式，验证 guard 能否检测到

echo "=== 1. next-step (英文+加粗) ==="
sleep 2
echo "**Next step:** /skill:validate plan.md"
sleep 3

echo "=== 2. next-step (中文+全角冒号) ==="
sleep 2
echo "下一步： /skill:commit"
sleep 3

echo "=== 3. Follow-up ==="
sleep 2
echo "💬 Follow-up: 请检查代码与计划是否一致"
sleep 3

echo "=== 4. 中文问句 ==="
sleep 2
echo "要不要继续执行 Phase 2？"
sleep 3

echo "=== 5. 选择题（choice-prompt） ==="
sleep 2
echo "请选择接下来要执行的操作："
echo "1. 继续  2. 跳过  3. 取消"
sleep 3

echo "=== 6. 确认提示（Y/N） ==="
sleep 2
echo "Confirm changes? (Y/N)"
sleep 3

echo "=== 7. 按键提示 ==="
sleep 2
echo "Press Enter to continue..."
sleep 3

echo "=== 8. 验证结果 ==="
sleep 2
echo "Verdict: PASS"
sleep 3

echo "=== 9. 实施完成 ==="
sleep 2
echo "Implementation complete at Phase 2"
sleep 3

echo "=== 10. 英文问句 ==="
sleep 2
echo "Shall I proceed with the next phase?"
sleep 3

echo "=== 11. 输入提示 ==="
sleep 2
echo "请输入你的选择："
sleep 3

echo "=== 12. 通用问号 ==="
sleep 2
echo "要开始下一步吗？"
sleep 3

echo "=== 全部完成 ==="
