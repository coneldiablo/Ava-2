from src.core.voice_channel_policy import append_policy


def test_shared_policy_preserves_business_instructions_and_is_idempotent():
    prompt = append_policy('Контекст бизнеса. Избранные товары и цены.')
    assert prompt.startswith('Контекст бизнеса. Избранные товары и цены.')
    assert 'не более одного раза' in prompt
    assert 'mcp_sales_customer_summary' in prompt
    assert 'mcp_sales_send_followup' in prompt
    assert 'другом номере' in prompt
    assert append_policy(prompt) == prompt
