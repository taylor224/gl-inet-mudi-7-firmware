-- Parameter validation for the rssiguard RPC object.
return {
    get_config = true,
    get_status = true,
    set_config = true,
    clear_bans = true,
    add_exempt = {
        mac = '^%x%x:%x%x:%x%x:%x%x:%x%x:%x%x$',
        note = '^[%w%s%.%-_,:()]*$'
    },
    remove_exempt = {
        id = '^[%w_]+$'
    }
}
