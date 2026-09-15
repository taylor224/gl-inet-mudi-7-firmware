-- Parameter validation for the cellguard RPC object.
--
-- oui.rpc applies a default pattern of ^[%w%.%s%-_:#/]-$ to every string
-- argument, which would reject nothing we send but also would not check the
-- shapes we care about. These patterns are tighter.
return {
    get_config = true,
    get_status = true,
    probe = true,
    unlock = true,
    set_config = true,
    add_block = {
        cid = '^[%x]*$',
        note = '^[%w%s%.%-_,:()]*$'
    },
    block_current = {
        note = '^[%w%s%.%-_,:()]*$'
    },
    remove_block = {
        id = '^[%w_]+$'
    }
}
