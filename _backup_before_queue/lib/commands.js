const { SlashCommandBuilder: S, ContextMenuCommandBuilder, ApplicationCommandType, ChannelType, InteractionContextType, PermissionFlagsBits: P } = require('discord.js');

const guildOnly = (b) => b.setContexts(InteractionContextType.Guild);
const admin = (b) => guildOnly(b).setDefaultMemberPermissions(P.ManageGuild);

const commands = [
  guildOnly(new S().setName('help').setDescription('Show the commands this bot has')),

  admin(new S().setName('panel').setDescription('Ticket panels defined in panels.json'))
    .addSubcommand((c) => c.setName('list').setDescription('List available panels'))
    .addSubcommand((c) => c.setName('send').setDescription('Post a panel')
      .addStringOption((o) => o.setName('panel').setDescription('Panel id from panels.json').setRequired(true).setAutocomplete(true))
      .addChannelOption((o) => o.setName('channel').setDescription('Where to post it (default: here)').addChannelTypes(ChannelType.GuildText))),

  admin(new S().setName('settings').setDescription('Server ticket settings'))
    .addSubcommand((c) => c.setName('view').setDescription('Show current settings'))
    .addSubcommand((c) => c.setName('set').setDescription('Change settings (only fill in what you want to change)')
      .addChannelOption((o) => o.setName('opened_log').setDescription('Channel for Ticket Opened logs').addChannelTypes(ChannelType.GuildText))
      .addChannelOption((o) => o.setName('closed_log').setDescription('Channel for Ticket Closed logs').addChannelTypes(ChannelType.GuildText))
      .addChannelOption((o) => o.setName('category').setDescription('Add a category for tickets (up to 25)').addChannelTypes(ChannelType.GuildCategory))
      .addBooleanOption((o) => o.setName('clear_categories').setDescription('Remove all saved categories first'))
      .addStringOption((o) => o.setName('claim_mode').setDescription('What /claim does').addChoices(
        { name: 'Disabled', value: 'disabled' }, { name: 'Enabled - No changes', value: 'nochange' },
        { name: 'Enabled - Read-only for others', value: 'readonly' }, { name: 'Enabled - Private on claim', value: 'private' }))
      .addBooleanOption((o) => o.setName('ping_author').setDescription('Ping the ticket author on claim'))
      .addIntegerOption((o) => o.setName('max_per_user').setDescription('Max open tickets per user').setMinValue(1))
      .addIntegerOption((o) => o.setName('max_total').setDescription('Max open tickets in the server').setMinValue(1))
      .addBooleanOption((o) => o.setName('close_requires_reason').setDescription('Ask for a reason when closing'))
      .addBooleanOption((o) => o.setName('close_requires_support').setDescription('Only staff can close (not the author)'))
      .addBooleanOption((o) => o.setName('dm_on_close').setDescription('DM the author when their ticket closes'))
      .addStringOption((o) => o.setName('default_close_reason').setDescription('Reason used when none is given'))
      .addBooleanOption((o) => o.setName('hide_closer').setDescription('Show "Staff Team" instead of who closed it'))
      .addIntegerOption((o) => o.setName('auto_close_hours').setDescription('Close after N hours of inactivity (0 = off)').setMinValue(0))
      .addBooleanOption((o) => o.setName('auto_close_on_leave').setDescription('Close tickets when the author leaves'))
      .addBooleanOption((o) => o.setName('log_staff_counts').setDescription('List staff message counts in the close log'))
      .addStringOption((o) => o.setName('color').setDescription('Embed color, e.g. #d4af37'))),

  admin(new S().setName('roles').setDescription('Manage support and blocked roles'))
    .addStringOption((o) => o.setName('action').setDescription('What to do').setRequired(true).addChoices(
      { name: 'Add support role', value: 'support_add' }, { name: 'Remove support role', value: 'support_remove' },
      { name: 'Add blocked role', value: 'blocked_add' }, { name: 'Remove blocked role', value: 'blocked_remove' }))
    .addRoleOption((o) => o.setName('role').setDescription('The role').setRequired(true)),

  guildOnly(new S().setName('claim').setDescription('Claim this ticket')),
  guildOnly(new S().setName('unclaim').setDescription('Release your claim')),
  guildOnly(new S().setName('transfer').setDescription('Transfer this claimed ticket')
    .addUserOption((o) => o.setName('user').setDescription('New claimer').setRequired(true))),
  guildOnly(new S().setName('close').setDescription('Close this ticket')
    .addStringOption((o) => o.setName('reason').setDescription('Why is it being closed?'))),
  guildOnly(new S().setName('add').setDescription('Add a user or role to this ticket')
    .addUserOption((o) => o.setName('user').setDescription('User to add'))
    .addRoleOption((o) => o.setName('role').setDescription('Role to add'))),
  guildOnly(new S().setName('remove').setDescription('Remove a user or role from this ticket')
    .addUserOption((o) => o.setName('user').setDescription('User to remove'))
    .addRoleOption((o) => o.setName('role').setDescription('Role to remove'))),
  guildOnly(new S().setName('rename').setDescription('Rename this ticket channel')
    .addStringOption((o) => o.setName('name').setDescription('New name').setRequired(true).setMaxLength(100))),
  guildOnly(new S().setName('priority').setDescription('Set this ticket\'s priority')
    .addStringOption((o) => o.setName('level').setDescription('Priority').setRequired(true).addChoices(
      { name: 'Low', value: 'low' }, { name: 'Normal', value: 'normal' }, { name: 'High', value: 'high' }, { name: 'Urgent', value: 'urgent' }))),
  guildOnly(new S().setName('createticket').setDescription('Open a ticket on behalf of a member (staff)')
    .addUserOption((o) => o.setName('user').setDescription('Member').setRequired(true))
    .addStringOption((o) => o.setName('type').setDescription('Ticket type label'))
    .addStringOption((o) => o.setName('reason').setDescription('Short reason'))),

  new ContextMenuCommandBuilder().setName('Create Ticket').setType(ApplicationCommandType.Message)
    .setContexts(InteractionContextType.Guild),
].map((c) => c.toJSON());

module.exports = { commands };
